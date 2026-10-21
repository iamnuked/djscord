import CoreAudio
import Foundation
import Network

/// Exposes system audio from a Core Audio process tap as a live WAV stream.
/// It never opens an input device, so microphone audio is not part of the output.
final class SystemAudioStreamServer {
  private let queue = DispatchQueue(label: "com.djscord.system-audio")
  private let listener: NWListener
  private var clients: [ObjectIdentifier: NWConnection] = [:]
  private let wavHeader: Data
  private var sampleCount = 0
  private var pendingSends: [ObjectIdentifier: Int] = [:]
  var onFailure: ((String) -> Void)?

  init(port: UInt16, sampleRate: UInt32) throws {
    guard let port = NWEndpoint.Port(rawValue: port) else {
      throw CaptureError.invalidPort
    }
    listener = try NWListener(using: .tcp, on: port)
    wavHeader = Self.makeWavHeader(sampleRate: sampleRate)
    listener.newConnectionHandler = { [weak self] connection in
      self?.accept(connection)
    }
  }

  func start() {
    listener.stateUpdateHandler = { state in
      switch state {
      case .ready:
        print("시스템 오디오 스트림 준비됨: http://0.0.0.0:\(self.listener.port!.rawValue)/system-audio.wav")
      case .failed(let error):
        if let onFailure = self.onFailure { onFailure("오디오 스트림 서버 시작 실패: \(error)") }
        else {
          fputs("HTTP 서버 시작 실패: \(error)\n", stderr)
          exit(1)
        }
      default:
        break
      }
    }
    listener.start(queue: queue)
  }

  func stop() {
    queue.sync {
      listener.cancel()
      clients.values.forEach { $0.cancel() }
      clients.removeAll()
      pendingSends.removeAll()
    }
  }

  func consume(_ bufferList: UnsafePointer<AudioBufferList>, format: AudioStreamBasicDescription) {
    let channels = Int(format.mChannelsPerFrame)
    let buffers = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: bufferList))
    let planar = (format.mFormatFlags & kAudioFormatFlagIsNonInterleaved) != 0
    guard !buffers.isEmpty else { return }
    let frames = Int(buffers[0].mDataByteSize) / ((planar ? 1 : channels) * 4)
    guard frames > 0, buffers.count == (planar ? channels : 1),
          buffers.allSatisfy({
            $0.mData != nil && Int($0.mDataByteSize) >= frames * (planar ? 1 : channels) * 4
          }) else { return }
    var audio = Data(capacity: frames * channels * 2)
    for frame in 0..<frames {
      for channel in 0..<channels {
        let buffer = buffers[planar ? channel : 0]
        let samples = buffer.mData!.assumingMemoryBound(to: Float.self)
        let value = samples[planar ? frame : frame * channels + channel]
        let bounded = value.isFinite ? max(-1, min(1, value)) : 0
        audio.appendLittleEndian(Int16((bounded * 32_767).rounded()))
      }
    }
    send(audio)
  }

  func send(_ payload: Data) {
    queue.async { [weak self] in
      guard let self else { return }
      if self.sampleCount == 0 {
        print("Core Audio 시스템 오디오 수신 확인 → PCM 16-bit 스테레오 WAV")
      }
      self.sampleCount += payload.count / 4
      for connection in self.clients.values {
        let id = ObjectIdentifier(connection)
        // A stalled reader must not accumulate unbounded audio in memory.
        guard (self.pendingSends[id] ?? 0) < 8 else {
          connection.cancel()
          self.clients.removeValue(forKey: id)
          self.pendingSends.removeValue(forKey: id)
          continue
        }
        self.pendingSends[id, default: 0] += 1
        connection.send(content: payload, completion: .contentProcessed { [weak self] error in
          self?.pendingSends[id, default: 1] -= 1
          if error != nil {
            self?.clients.removeValue(forKey: id)
            self?.pendingSends.removeValue(forKey: id)
            connection.cancel()
          }
        })
      }
    }
  }

  private func accept(_ connection: NWConnection) {
    connection.start(queue: queue)
    connection.receive(minimumIncompleteLength: 1, maximumLength: 4_096) { [weak self] _, _, _, error in
      guard let self, error == nil else {
        connection.cancel()
        return
      }
      let response = Data("HTTP/1.1 200 OK\r\nContent-Type: audio/wav\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n".utf8) + self.wavHeader
      let identifier = ObjectIdentifier(connection)
      self.clients[identifier] = connection
      connection.send(content: response, completion: .contentProcessed { [weak self] error in
        if error != nil {
          self?.clients.removeValue(forKey: identifier)
          connection.cancel()
        }
      })
    }
  }

  private static func makeWavHeader(sampleRate: UInt32) -> Data {
    // 0xffffffff denotes an unknown/streaming data length, which is valid for WAV streams.
    var header = Data()
    header.append(contentsOf: "RIFF".utf8)
    header.appendLittleEndian(UInt32.max)
    header.append(contentsOf: "WAVEfmt ".utf8)
    header.appendLittleEndian(UInt32(16))
    header.appendLittleEndian(UInt16(1)) // PCM
    header.appendLittleEndian(UInt16(2)) // stereo
    header.appendLittleEndian(sampleRate)
    header.appendLittleEndian(sampleRate * 4)
    header.appendLittleEndian(UInt16(4)) // bytes per stereo frame
    header.appendLittleEndian(UInt16(16))
    header.append(contentsOf: "data".utf8)
    header.appendLittleEndian(UInt32.max)
    return header
  }
}

private enum CaptureError: Error {
  case invalidPort
  case unsupportedFormat
  case coreAudio(String, OSStatus)
}

@available(macOS 14.2, *)
final class SystemAudioTap {
  private var tap: AudioObjectID = kAudioObjectUnknown
  private var device: AudioObjectID = kAudioObjectUnknown
  private var ioProc: AudioDeviceIOProcID?
  private let captureQueue = DispatchQueue(label: "com.djscord.system-audio.tap")
  private(set) var format = AudioStreamBasicDescription()

  init(processes: [AudioObjectID]? = nil) throws {
    do {
      // Empty exclusions captures output from all apps, without any microphone subdevice.
      let description = processes.map { CATapDescription(stereoMixdownOfProcesses: $0) }
        ?? CATapDescription(stereoGlobalTapButExcludeProcesses: [])
      description.name = "djscord System Audio"
      description.uuid = UUID()
      description.isPrivate = true
      description.muteBehavior = .unmuted
      try check(AudioHardwareCreateProcessTap(description, &tap), "오디오 탭 생성")
      var address = AudioObjectPropertyAddress(
        mSelector: kAudioTapPropertyFormat,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
      )
      var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
      try check(AudioObjectGetPropertyData(tap, &address, 0, nil, &size, &format), "오디오 형식 조회")
      guard format.mFormatID == kAudioFormatLinearPCM,
            format.mChannelsPerFrame == 2, format.mBitsPerChannel == 32,
            format.mSampleRate > 0,
            (format.mFormatFlags & kAudioFormatFlagIsFloat) != 0 else {
        throw CaptureError.unsupportedFormat
      }
      let composition: [String: Any] = [
        kAudioAggregateDeviceNameKey: "djscord System Audio",
        kAudioAggregateDeviceUIDKey: "com.djscord.system-audio.\(UUID().uuidString)",
        kAudioAggregateDeviceIsPrivateKey: true,
        kAudioAggregateDeviceTapAutoStartKey: false,
        kAudioAggregateDeviceTapListKey: [[
          kAudioSubTapUIDKey: description.uuid.uuidString,
          kAudioSubTapDriftCompensationKey: true
        ]]
      ]
      try check(AudioHardwareCreateAggregateDevice(composition as CFDictionary, &device), "탭 입력 장치 생성")
    } catch {
      stop()
      throw error
    }
  }

  func start(server: SystemAudioStreamServer) throws {
    try start { input, format in server.consume(input, format: format) }
  }

  func start(handler: @escaping (UnsafePointer<AudioBufferList>, AudioStreamBasicDescription) -> Void) throws {
    let streamFormat = format
    try check(AudioDeviceCreateIOProcIDWithBlock(&ioProc, device, captureQueue) {
      _, input, _, _, _ in
      handler(input, streamFormat)
    }, "오디오 콜백 등록")
    try check(AudioDeviceStart(device, ioProc), "시스템 오디오 캡처 시작")
  }

  func stop() {
    if let ioProc {
      AudioDeviceStop(device, ioProc)
      AudioDeviceDestroyIOProcID(device, ioProc)
      self.ioProc = nil
    }
    if device != kAudioObjectUnknown {
      AudioHardwareDestroyAggregateDevice(device)
      device = kAudioObjectUnknown
    }
    if tap != kAudioObjectUnknown {
      AudioHardwareDestroyProcessTap(tap)
      tap = kAudioObjectUnknown
    }
  }

  deinit { stop() }

  private func check(_ status: OSStatus, _ operation: String) throws {
    if status != noErr { throw CaptureError.coreAudio(operation, status) }
  }
}

extension Data {
  mutating func appendLittleEndian<T: FixedWidthInteger>(_ value: T) {
    var littleEndian = value.littleEndian
    Swift.withUnsafeBytes(of: &littleEndian) { append(contentsOf: $0) }
  }
}

#if !DJSCORD_LIBRARY
@main
struct DjscordSystemAudioCapture {
  static func main() {
    guard #available(macOS 14.2, *) else {
      fputs("Core Audio taps는 macOS 14.2 이상이 필요합니다.\n", stderr)
      exit(1)
    }
    let port = UInt16(CommandLine.arguments.dropFirst().first ?? "8788") ?? 8788
    do {
      print("시스템 오디오 녹음 권한을 요청하면 허용하세요. 화면·마이크는 캡처하지 않습니다.")
      let tap = try SystemAudioTap()
      let server = try SystemAudioStreamServer(port: port, sampleRate: UInt32(tap.format.mSampleRate))
      server.start()
      try tap.start(server: server)
      let finished = DispatchSemaphore(value: 0)
      signal(SIGINT, SIG_IGN)
      signal(SIGTERM, SIG_IGN)
      let signals = [SIGINT, SIGTERM].map { number -> DispatchSourceSignal in
        let source = DispatchSource.makeSignalSource(signal: number, queue: .global())
        source.setEventHandler { finished.signal() }
        source.resume()
        return source
      }
      print("Core Audio taps로 시스템 오디오 캡처 중입니다. 종료하려면 Ctrl+C를 누르세요.")
      finished.wait()
      signals.forEach { $0.cancel() }
      tap.stop()
      server.stop()
    } catch {
      fputs("시스템 오디오 캡처를 시작하지 못했습니다: \(error)\n", stderr)
      exit(1)
    }
  }
}
#endif
