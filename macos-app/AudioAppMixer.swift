import AppKit
import CoreAudio
import Foundation

struct AudioMixerChannel: Identifiable {
  let id: String
  let name: String
  let icon: NSImage?
  var enabled: Bool
  var volume: Double
  var level: Double = 0
  var status: String = "선택 안 됨"
}

/// Publish one changed snapshot instead of notifying SwiftUI for every field on every tick.
enum AudioMixerMeterUpdate {
  static func applying(to channels: [AudioMixerChannel], levels: [String: Double],
                       statuses: [String: String]) -> [AudioMixerChannel]? {
    var updated = channels
    var changed = false
    for index in updated.indices {
      let id = updated[index].id
      let level = levels[id] ?? 0
      let status = statuses[id] ?? "선택 안 됨"
      if updated[index].level != level || updated[index].status != status {
        updated[index].level = level
        updated[index].status = status
        changed = true
      }
    }
    return changed ? updated : nil
  }
}

/// dBFS: 디지털 오디오의 최대 레벨(0dB)을 기준으로 표시합니다.
enum AudioMeterScale {
  static let floorDB = -60.0

  static func decibels(_ level: Double) -> Double {
    guard level.isFinite, level > 0 else { return floorDB }
    return max(floorDB, min(0, 20 * log10(level)))
  }

  static func fraction(_ level: Double) -> Double {
    (decibels(level) - floorDB) / -floorDB
  }
}

struct MeterPeakWindow {
  private var peaks: [String: Double] = [:]

  mutating func record(_ levels: [String: Double]) {
    for (id, level) in levels { peaks[id] = max(peaks[id] ?? 0, level) }
  }

  mutating func take(activeIDs: Set<String>) -> [String: Double] {
    let result = peaks.filter { activeIDs.contains($0.key) }
    peaks.removeAll(keepingCapacity: true)
    return result
  }
}

/// Stateful interpolation keeps fractional sample positions across input buffers.
/// The bus is always 48kHz stereo even when a source device uses 44.1kHz.
struct StereoResampler {
  var samples: [Float] = []
  var position = 0.0

  mutating func convert(_ input: [Float], sampleRate: Double) -> [Float] {
    guard sampleRate > 0, input.count.isMultiple(of: 2) else { return [] }
    if sampleRate == 48_000 { return input }
    samples.append(contentsOf: input)
    let frames = samples.count / 2
    let step = sampleRate / 48_000
    var output: [Float] = []
    while position + 1 < Double(frames) {
      let frame = Int(position)
      let fraction = Float(position - Double(frame))
      for channel in 0..<2 {
        let a = samples[frame * 2 + channel]
        let b = samples[(frame + 1) * 2 + channel]
        output.append(a + (b - a) * fraction)
      }
      position += step
    }
    let consumed = min(Int(position), max(0, frames - 1))
    samples.removeFirst(consumed * 2)
    position -= Double(consumed)
    return output
  }
}

struct MixerBuffer {
  var samples: [Float] = []
  var cursor = 0
  var resampler = StereoResampler()
  var level = 0.0

  mutating func append(_ data: [Float], sampleRate: Double) {
    if cursor > 9_600 {
      samples.removeFirst(cursor)
      cursor = 0
    }
    samples.append(contentsOf: resampler.convert(data, sampleRate: sampleRate))
    // Keep at most half a second of source audio if processing ever falls behind.
    if samples.count - cursor > 48_000 {
      cursor = samples.count - 48_000
    }
  }

  mutating func mix(into output: inout [Float], gain: Float) {
    let count = min(output.count, samples.count - cursor)
    var peak: Float = 0
    for index in 0..<count {
      let value = samples[cursor + index] * gain
      output[index] += value
      peak = max(peak, abs(value))
    }
    cursor += count
    level = Double(min(1, peak))
  }
}

@available(macOS 14.2, *)
final class AppAudioMixer {
  private let queue = DispatchQueue(label: "com.djscord.app-mixer", qos: .userInitiated)
  private let server: SystemAudioStreamServer
  private var taps: [String: SystemAudioTap] = [:]
  private var processSets: [String: [AudioObjectID]] = [:]
  private var buffers: [String: MixerBuffer] = [:]
  private var settings: [String: Double] = [:]
  private var statuses: [String: String] = [:]
  private var timer: DispatchSourceTimer?
  private var ticks = 0
  private var meterPeaks = MeterPeakWindow()
  private var generations: [String: UUID] = [:]
  var onLevels: (([String: Double], [String: String]) -> Void)?
  var onFailure: ((String) -> Void)?

  init() throws {
    server = try SystemAudioStreamServer(port: 8788, sampleRate: 48_000)
    server.onFailure = { [weak self] message in self?.onFailure?(message) }
    server.start()
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now(), repeating: .milliseconds(10), leeway: .milliseconds(1))
    timer.setEventHandler { [weak self] in self?.render() }
    self.timer = timer
    timer.resume()
  }

  static func availableChannels() -> [AudioMixerChannel] {
    var seen = Set<String>()
    return NSWorkspace.shared.runningApplications.compactMap { app in
      guard app.activationPolicy == .regular, let id = app.bundleIdentifier,
            id != Bundle.main.bundleIdentifier, seen.insert(id).inserted else { return nil }
      return AudioMixerChannel(id: id, name: app.localizedName ?? id, icon: app.icon,
        enabled: false, volume: 100)
    }.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
  }

  func configure(_ channels: [AudioMixerChannel]) {
    let active = channels.filter(\.enabled)
    let roots = channels.map(\.id).sorted { $0.count > $1.count }
    queue.async { [weak self] in
      guard let self else { return }
      self.settings = Dictionary(uniqueKeysWithValues: active.map { ($0.id, max(0, min(100, $0.volume)) / 100) })
      let processes = Self.outputProcesses(roots: roots)
      for id in Array(self.taps.keys) where self.settings[id] == nil || self.processSets[id] != processes[id] {
        self.taps.removeValue(forKey: id)?.stop()
        self.buffers.removeValue(forKey: id)
        self.processSets.removeValue(forKey: id)
        self.generations.removeValue(forKey: id)
      }
      self.statuses = [:]
      for channel in active {
        guard let ids = processes[channel.id], !ids.isEmpty else {
          self.statuses[channel.id] = "앱의 오디오 재생 대기"
          continue
        }
        if self.taps[channel.id] == nil {
          do {
            let tap = try SystemAudioTap(processes: ids)
            self.buffers[channel.id] = MixerBuffer()
            let id = channel.id
            let generation = UUID()
            self.generations[id] = generation
            try tap.start { [weak self] list, format in
              let samples = Self.copyStereoSamples(list, format: format)
              guard !samples.isEmpty else { return }
              self?.queue.async { [weak self] in
                guard let self, self.settings[id] != nil, self.generations[id] == generation else { return }
                self.buffers[id]?.append(samples, sampleRate: format.mSampleRate)
              }
            }
            self.taps[id] = tap
            self.processSets[id] = ids
          } catch {
            self.buffers.removeValue(forKey: channel.id)
            self.statuses[channel.id] = "캡처 실패: \(error)"
            continue
          }
        }
        self.statuses[channel.id] = channel.volume == 0 ? "음소거" : "송출 선택됨"
      }
    }
  }

  func stop() {
    queue.sync {
      timer?.cancel()
      timer = nil
      taps.values.forEach { $0.stop() }
      taps.removeAll()
      buffers.removeAll()
      generations.removeAll()
    }
    server.stop()
  }

  func setGain(_ id: String, volume: Double) {
    queue.async { [weak self] in
      guard let self, self.settings[id] != nil else { return }
      self.settings[id] = max(0, min(100, volume)) / 100
      self.statuses[id] = volume == 0 ? "음소거" : "송출 선택됨"
    }
  }

  private func render() {
    var mixed = [Float](repeating: 0, count: 960) // 10ms, stereo, 48kHz
    for id in Array(buffers.keys) {
      buffers[id]?.mix(into: &mixed, gain: Float(settings[id] ?? 0))
    }
    var data = Data(capacity: mixed.count * 2)
    for value in mixed {
      let bounded = value.isFinite ? max(-1, min(1, value)) : 0
      data.appendLittleEndian(Int16((bounded * 32_767).rounded()))
    }
    server.send(data)
    ticks += 1
    // 20ms마다 바로 표시하되, 두 오디오 블록 사이의 짧은 피크도 놓치지 않습니다.
    meterPeaks.record(buffers.mapValues(\.level))
    if ticks.isMultiple(of: 2) {
      let levels = meterPeaks.take(activeIDs: Set(buffers.keys))
      let states = statuses
      onLevels?(levels, states)
    }
  }

  private static func copyStereoSamples(_ list: UnsafePointer<AudioBufferList>, format: AudioStreamBasicDescription) -> [Float] {
    let buffers = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: list))
    let planar = (format.mFormatFlags & kAudioFormatFlagIsNonInterleaved) != 0
    guard format.mChannelsPerFrame == 2, !buffers.isEmpty,
          buffers.count == (planar ? 2 : 1) else { return [] }
    let frames = Int(buffers[0].mDataByteSize) / (planar ? 4 : 8)
    guard buffers.allSatisfy({ $0.mData != nil && Int($0.mDataByteSize) >= frames * (planar ? 4 : 8) }) else { return [] }
    var samples = [Float](repeating: 0, count: frames * 2)
    for frame in 0..<frames {
      for channel in 0..<2 {
        samples[frame * 2 + channel] = buffers[planar ? channel : 0].mData!
          .assumingMemoryBound(to: Float.self)[planar ? frame : frame * 2 + channel]
      }
    }
    return samples
  }

  static func outputProcesses(roots: [String]) -> [String: [AudioObjectID]] {
    var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyProcessObjectList,
      mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    let system = AudioObjectID(kAudioObjectSystemObject)
    guard AudioObjectGetPropertyDataSize(system, &address, 0, nil, &size) == noErr else { return [:] }
    guard size > 0 else { return [:] }
    var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    let status = ids.withUnsafeMutableBytes {
      AudioObjectGetPropertyData(system, &address, 0, nil, &size, $0.baseAddress!)
    }
    guard status == noErr else { return [:] }
    var grouped: [String: [AudioObjectID]] = [:]
    for id in ids {
      var bundleAddress = AudioObjectPropertyAddress(mSelector: kAudioProcessPropertyBundleID,
        mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
      var bundle: Unmanaged<CFString>?
      var bundleSize = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
      guard AudioObjectGetPropertyData(id, &bundleAddress, 0, nil, &bundleSize, &bundle) == noErr,
            let bundle else { continue }
      let identifier = bundle.takeRetainedValue() as String
      if let root = roots.first(where: { identifier == $0 || identifier.hasPrefix($0 + ".") }) {
        grouped[root, default: []].append(id)
      }
    }
    return grouped.mapValues { $0.sorted() }
  }
}
