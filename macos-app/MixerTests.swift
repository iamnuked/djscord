import Foundation

@main
struct MixerTests {
  static func main() {
    assert(AudioMeterScale.fraction(0) == 0)
    assert(AudioMeterScale.fraction(1) == 1)
    assert(AudioMeterScale.fraction(2) == 1)
    assert(AudioMeterScale.fraction(.nan) == 0)
    assert(abs(AudioMeterScale.decibels(0.1) + 20) < 0.00001)
    let channel = AudioMixerChannel(id: "source", name: "Test", icon: nil, enabled: true, volume: 37)
    assert(AudioMixerMeterUpdate.applying(to: [channel], levels: [:], statuses: [:]) == nil,
      "Unchanged silent ticks must not republish the entire SwiftUI screen")
    let changed = AudioMixerMeterUpdate.applying(to: [channel], levels: ["source": 0.9],
      statuses: ["source": "송출 선택됨"])!
    assert(changed[0].level == 0.9 && changed[0].volume == 37 && changed[0].enabled)
    assert(AudioMixerMeterUpdate.applying(to: changed, levels: ["source": 0.9],
      statuses: ["source": "송출 선택됨"]) == nil)
    var meter = MeterPeakWindow()
    meter.record(["source": 0.9, "removed": 1])
    meter.record(["source": 0.1])
    assert(meter.take(activeIDs: ["source"]) == ["source": 0.9], "Short peaks must survive until the next display update")
    meter.record(["source": 0])
    assert(meter.take(activeIDs: ["source"]) == ["source": 0], "Meter must drop to silence immediately without smoothing")
    var chrome = MixerBuffer()
    var rekordbox = MixerBuffer()
    chrome.append([0.8, 0.4, 0.8, 0.4], sampleRate: 48_000)
    rekordbox.append([0.2, 0.6, 0.2, 0.6], sampleRate: 48_000)
    var output = [Float](repeating: 0, count: 4)
    chrome.mix(into: &output, gain: 0.5)
    rekordbox.mix(into: &output, gain: 0.25)
    assert(abs(output[0] - 0.45) < 0.00001 && abs(output[1] - 0.35) < 0.00001)

    var muted = MixerBuffer()
    muted.append([0.9, 0.9], sampleRate: 48_000)
    var silence = [Float](repeating: 0, count: 4)
    muted.mix(into: &silence, gain: 0)
    assert(silence.allSatisfy { $0 == 0 }, "Muted sources and missing frames must be silent")

    let input = (0..<4_410).flatMap { frame -> [Float] in
      let value = Float(sin(Double(frame) * 0.04))
      return [value, -value]
    }
    var whole = StereoResampler()
    let expected = whole.convert(input, sampleRate: 44_100)
    var split = StereoResampler()
    var actual: [Float] = []
    for offset in stride(from: 0, to: input.count, by: 882) {
      actual += split.convert(Array(input[offset..<min(offset + 882, input.count)]), sampleRate: 44_100)
    }
    assert(actual.count == expected.count)
    assert(zip(actual, expected).allSatisfy { abs($0 - $1) < 0.0001 }, "Resampling must be continuous across buffers")

    var backlog = MixerBuffer()
    backlog.append([Float](repeating: 1, count: 96_000), sampleRate: 48_000)
    assert(backlog.samples.count - backlog.cursor <= 48_000)
    print("믹서 검증 통과: dB 미터·짧은 피크·즉시 무음·채널 합산·개별 볼륨·음소거·연속 리샘플링·버퍼 상한")
    if #available(macOS 14.2, *) {
      let channels = AppAudioMixer.availableChannels()
      let processes = AppAudioMixer.outputProcesses(roots: channels.map(\.id).sorted { $0.count > $1.count })
      print("실행 중인 앱 \(channels.count)개, 오디오 프로세스가 있는 앱 채널 \(processes.count)개")
    }
  }
}
