import AppKit
import Security
import SwiftUI

struct Channel: Decodable, Identifiable, Hashable {
  let id: String
  let name: String
}
struct PlayerState: Decodable {
  let voiceChannelId: String?
  let title: String
  let author: String
  let playing: Bool
  let paused: Bool
  let volume: Double
  let systemAudio: Bool
  let queue: [String]
}
struct Guild: Decodable, Identifiable {
  let id: String
  let name: String
  let voiceChannels: [Channel]
  let textChannels: [Channel]
  let player: PlayerState?
}
struct Snapshot: Decodable {
  let ready: Bool
  let audioReady: Bool
  let botName: String
  let guilds: [Guild]
}
struct ControlCommand: Encodable {
  var guildId: String
  var action: String
  var voiceChannelId: String?
  var textChannelId: String?
  var query: String?
  var volume: Int?
}
struct ApiFailure: Decodable { let error: String }
enum StudioError: LocalizedError {
  case message(String)
  var errorDescription: String? {
    switch self { case .message(let message): return message }
  }
}

@MainActor
final class StudioModel: ObservableObject {
  @Published var snapshot: Snapshot?
  @Published var selectedGuild = ""
  @Published var voiceChannel = ""
  @Published var textChannel = ""
  @Published var query = ""
  @Published var volume = 100.0
  @Published var busy = false
  @Published var connected = false
  @Published var captureRunning = false
  @Published var audioChannels: [AudioMixerChannel] = []
  @Published var notice = "봇 연결을 확인하고 있습니다."
  @Published var error: String?
  @Published var logs = ""
  @Published var showLogs = false
  @Published var projectPath: String
  private var polling: Task<Void, Never>?
  private var audioMixer: AppAudioMixer?
  @Published var shuttingDown = false

  var guild: Guild? { snapshot?.guilds.first { $0.id == selectedGuild } }
  var player: PlayerState? { guild?.player }

  init() {
    projectPath = UserDefaults.standard.string(forKey: "projectPath")
      ?? Bundle.main.object(forInfoDictionaryKey: "DjscordProjectPath") as? String ?? ""
    refreshAudioChannels()
    polling = Task { [weak self] in
      while !Task.isCancelled {
        await self?.refresh()
        self?.refreshAudioChannels()
        try? await Task.sleep(nanoseconds: 3_000_000_000)
      }
    }
  }

  func chooseProject() {
    let panel = NSOpenPanel()
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.message = "djscord 프로젝트 폴더를 선택하세요."
    if panel.runModal() == .OK, let url = panel.url {
      projectPath = url.path
      UserDefaults.standard.set(projectPath, forKey: "projectPath")
      Task { await refresh() }
    }
  }

  private func token() throws -> String {
    let url = URL(fileURLWithPath: projectPath).appendingPathComponent(".desktop-control.env")
    if !FileManager.default.fileExists(atPath: url.path) {
      guard FileManager.default.fileExists(atPath: projectPath + "/compose.desktop.yaml") else {
        throw StudioError.message("설정에서 djscord 프로젝트 폴더를 선택해주세요.")
      }
      var bytes = [UInt8](repeating: 0, count: 32)
      guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
        throw StudioError.message("앱 연결 인증키를 만들지 못했습니다.")
      }
      let value = bytes.map { String(format: "%02x", $0) }.joined()
      try Data("DESKTOP_CONTROL_TOKEN=\(value)\n".utf8).write(to: url, options: .atomic)
      try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
    let content = try String(contentsOf: url, encoding: .utf8)
    guard let line = content.split(separator: "\n").first(where: { $0.hasPrefix("DESKTOP_CONTROL_TOKEN=") }) else {
      throw StudioError.message("앱 인증키 설정이 잘못되었습니다.")
    }
    return String(line.dropFirst("DESKTOP_CONTROL_TOKEN=".count))
  }

  private func request(_ path: String, command: ControlCommand? = nil) async throws -> Snapshot {
    var request = URLRequest(url: URL(string: "http://127.0.0.1:8789/" + path)!)
    request.timeoutInterval = 20
    request.setValue("Bearer " + (try token()), forHTTPHeaderField: "Authorization")
    if let command {
      request.httpMethod = "POST"
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = try JSONEncoder().encode(command)
    }
    let (data, response) = try await URLSession.shared.data(for: request)
    guard let response = response as? HTTPURLResponse, response.statusCode == 200 else {
      throw StudioError.message((try? JSONDecoder().decode(ApiFailure.self, from: data).error) ?? "봇 연결에 실패했습니다.")
    }
    return try JSONDecoder().decode(Snapshot.self, from: data)
  }

  func refresh() async {
    guard !busy && !shuttingDown else { return }
    do {
      snapshot = try await request("state")
      connected = true
      if !snapshot!.guilds.contains(where: { $0.id == selectedGuild }) {
        selectedGuild = snapshot!.guilds.first?.id ?? ""
        selectChannels()
      }
      if let player { volume = player.volume }
      if notice == "봇 연결을 확인하고 있습니다." { notice = "방송할 서버와 음성 채널을 선택하세요." }
    } catch {
      connected = false
      if !busy && !notice.hasPrefix("서버가 종료되었습니다.") { notice = "봇 시작 버튼으로 연결하세요." }
    }
  }

  func selectChannels() {
    voiceChannel = guild?.player?.voiceChannelId ?? guild?.voiceChannels.first?.id ?? ""
    textChannel = guild?.textChannels.first?.id ?? ""
    volume = player?.volume ?? 100
  }

  func run(_ operation: @escaping () async throws -> Void) {
    guard !busy && !shuttingDown else { return }
    busy = true
    error = nil
    Task {
      do { try await operation() }
      catch { self.error = error.localizedDescription }
      busy = false
      await refresh()
    }
  }

  func control(_ action: String, volume: Int? = nil) async throws {
    let command = ControlCommand(guildId: selectedGuild, action: action,
      voiceChannelId: voiceChannel.isEmpty ? nil : voiceChannel,
      textChannelId: textChannel.isEmpty ? nil : textChannel,
      query: action == "play" ? query : nil, volume: volume)
    snapshot = try await request("control", command: command)
    if action == "play" { query = "" }
    notice = action == "systemAudio" ? "시스템 오디오를 Discord에 방송하고 있습니다." : "요청을 처리했습니다."
  }

  private func dockerExecutable() throws -> String {
    for path in ["/usr/local/bin/docker", "/opt/homebrew/bin/docker", "/Applications/Docker.app/Contents/Resources/bin/docker"] {
      if FileManager.default.isExecutableFile(atPath: path) { return path }
    }
    throw StudioError.message("Docker Desktop을 설치하고 실행해주세요.")
  }

  func startBot() async throws {
    _ = try token()
    notice = "봇을 시작하고 있습니다. 최초 빌드는 잠시 걸릴 수 있습니다."
    logs = try await runDocker(["up", "-d", "--build", "bot"], failure: "봇 시작 실패")
    notice = "봇 시작 완료. Discord 연결을 기다리고 있습니다."
  }

  func stopBot() async throws {
    stopCapture()
    notice = "봇과 오디오 서버를 종료하고 있습니다."
    logs = try await runDocker(["stop", "--timeout", "10", "bot", "lavalink"], failure: "서버 종료 실패")
    snapshot = nil
    connected = false
    notice = "서버가 종료되었습니다. 봇 시작 버튼으로 다시 실행할 수 있습니다."
  }

  func prepareToQuit() async throws {
    shuttingDown = true
    // 진행 중인 빌드가 종료 명령 뒤에 서버를 다시 켜지 않도록 기다립니다.
    while busy { try await Task.sleep(nanoseconds: 100_000_000) }
    do {
      try await stopBot()
      polling?.cancel()
    } catch {
      shuttingDown = false
      throw error
    }
  }

  private func runDocker(_ arguments: [String], failure: String) async throws -> String {
    guard FileManager.default.fileExists(atPath: projectPath + "/compose.yaml"),
          FileManager.default.fileExists(atPath: projectPath + "/compose.desktop.yaml") else {
      throw StudioError.message("설정에서 djscord 프로젝트 폴더를 선택해주세요.")
    }
    let docker = try dockerExecutable()
    let root = projectPath
    let result: String = try await Task.detached {
      let process = Process()
      process.executableURL = URL(fileURLWithPath: docker)
      process.currentDirectoryURL = URL(fileURLWithPath: root)
      process.arguments = ["compose", "-f", "compose.yaml", "-f", "compose.desktop.yaml"] + arguments
      let pipe = Pipe()
      process.standardOutput = pipe
      process.standardError = pipe
      var environment = ProcessInfo.processInfo.environment
      environment["PATH"] = "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
      process.environment = environment
      try process.run()
      let data = pipe.fileHandleForReading.readDataToEndOfFile()
      process.waitUntilExit()
      let output = String(decoding: data, as: UTF8.self)
      guard process.terminationStatus == 0 else {
        throw StudioError.message(failure + ": Docker Desktop 실행 및 .env 설정을 확인하세요.\n" + String(output.suffix(1_500)))
      }
      return output
    }.value
    return String(result.suffix(6_000))
  }

  func startCapture() async throws {
    guard audioChannels.contains(where: { $0.enabled }) else {
      throw StudioError.message("송출할 앱 채널을 하나 이상 켜주세요.")
    }
    if audioMixer != nil {
      audioMixer?.configure(audioChannels)
      return
    }
    if await captureAvailable() {
      throw StudioError.message("기존 전체 시스템 오디오 도우미가 실행 중입니다. 해당 터미널에서 Ctrl+C로 종료한 뒤 앱별 믹서를 시작해주세요.")
    }
    let mixer = try AppAudioMixer()
    mixer.onLevels = { [weak self, weak mixer] levels, statuses in
      Task { @MainActor [weak self, weak mixer] in
        guard let self, let mixer, self.audioMixer === mixer else { return }
        if let updated = AudioMixerMeterUpdate.applying(to: self.audioChannels,
                                                       levels: levels, statuses: statuses) {
          self.audioChannels = updated
        }
        if !self.captureRunning { self.captureRunning = true }
      }
    }
    mixer.onFailure = { [weak self] message in
      Task { @MainActor [weak self] in self?.error = message; self?.stopCapture() }
    }
    audioMixer = mixer
    mixer.configure(audioChannels)
    notice = "시스템 오디오 녹음 권한 요청이 나타나면 허용해주세요."
    for _ in 0..<30 {
      if await captureAvailable() {
        guard audioMixer === mixer else { throw StudioError.message("오디오 믹서를 시작하지 못했습니다.") }
        captureRunning = true
        return
      }
      try await Task.sleep(nanoseconds: 500_000_000)
    }
    stopCapture()
    throw StudioError.message("캡처 준비를 확인하지 못했습니다. 시스템 오디오 권한을 확인하세요.")
  }

  private func captureAvailable() async -> Bool {
    do {
      var request = URLRequest(url: URL(string: "http://127.0.0.1:8788/system-audio.wav")!)
      request.timeoutInterval = 2
      let (bytes, response) = try await URLSession.shared.bytes(for: request)
      guard (response as? HTTPURLResponse)?.statusCode == 200 else { return false }
      var count = 0
      for try await _ in bytes {
        count += 1
        if count >= 48 { return true }
      }
    } catch {}
    return false
  }

  func broadcast() async throws {
    try await startCapture()
    try await control("systemAudio")
  }

  func stopCapture() {
    audioMixer?.stop()
    audioMixer = nil
    captureRunning = false
  }

  func refreshAudioChannels() {
    let saved = UserDefaults.standard.dictionary(forKey: "audioMixerChannels") ?? [:]
    audioChannels = AppAudioMixer.availableChannels().map { source in
      if let existing = audioChannels.first(where: { $0.id == source.id }) { return existing }
      var channel = source
      if let settings = saved[source.id] as? [String: Any] {
        channel.enabled = settings["enabled"] as? Bool ?? false
        channel.volume = settings["volume"] as? Double ?? 100
      }
      return channel
    }
    audioMixer?.configure(audioChannels)
  }

  func updateAudioChannel(_ id: String, enabled: Bool? = nil, volume: Double? = nil) {
    guard let index = audioChannels.firstIndex(where: { $0.id == id }) else { return }
    if let enabled { audioChannels[index].enabled = enabled }
    if let volume { audioChannels[index].volume = volume }
    var saved = UserDefaults.standard.dictionary(forKey: "audioMixerChannels") ?? [:]
    saved[id] = ["enabled": audioChannels[index].enabled, "volume": audioChannels[index].volume]
    UserDefaults.standard.set(saved, forKey: "audioMixerChannels")
    if enabled != nil { audioMixer?.configure(audioChannels) }
    else { audioMixer?.setGain(id, volume: audioChannels[index].volume) }
  }

  func endBroadcast() async throws {
    try await control("stop")
    if snapshot?.guilds.contains(where: { $0.player?.systemAudio == true }) != true {
      stopCapture()
    }
  }
}

struct StudioView: View {
  @ObservedObject var model: StudioModel
  private let accent = Color(red: 0.55, green: 0.47, blue: 1)

  var body: some View {
    HStack(spacing: 0) {
      sidebar
      Divider()
      ScrollView {
        VStack(alignment: .leading, spacing: 24) {
          HStack {
            VStack(alignment: .leading, spacing: 6) {
              Text("방송 스튜디오").font(.system(size: 28, weight: .bold))
              Text("맥의 소리를 Discord 음성 채널로").foregroundStyle(.secondary)
            }
            Spacer()
            if model.busy { ProgressView().controlSize(.small) }
            Label(model.connected ? "연결됨" : "연결 대기", systemImage: "circle.fill")
              .font(.caption).foregroundStyle(model.connected ? .green : .orange)
          }
          channelCard
          appMixerCard
          broadcastCard
          musicCard
          if let error = model.error {
            Label(error, systemImage: "exclamationmark.triangle.fill")
              .foregroundStyle(.orange).textSelection(.enabled)
          }
          Text(model.notice).font(.callout).foregroundStyle(.secondary)
          DisclosureGroup("실행 로그", isExpanded: $model.showLogs) {
            ScrollView {
              Text(model.logs.isEmpty ? "아직 로그가 없습니다." : model.logs)
                .font(.system(.caption, design: .monospaced))
                .textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
            }.frame(height: 140)
          }.foregroundStyle(.secondary)
        }.padding(30)
      }
    }
    .frame(minWidth: 900, minHeight: 680)
    .background(Color(nsColor: .windowBackgroundColor))
    .tint(accent)
    .onChange(of: model.selectedGuild) { model.selectChannels() }
    .onReceive(NotificationCenter.default.publisher(for: NSApplication.willTerminateNotification)) { _ in
      model.stopCapture()
    }
  }

  private var sidebar: some View {
    VStack(alignment: .leading, spacing: 22) {
      HStack(spacing: 10) {
        Image(systemName: "waveform.circle.fill").font(.system(size: 34)).foregroundStyle(accent)
        Text("djscord").font(.system(size: 24, weight: .bold))
      }
      Text("DISCORD SERVERS").font(.system(size: 10, weight: .semibold)).foregroundStyle(.secondary)
      if model.snapshot?.guilds.isEmpty != false {
        Text("봇을 연결하면 서버가 표시됩니다.").font(.callout).foregroundStyle(.secondary)
      }
      ForEach(model.snapshot?.guilds ?? []) { guild in
        Button { model.selectedGuild = guild.id } label: {
          HStack {
            Image(systemName: "number.square.fill")
            Text(guild.name).lineLimit(2)
            Spacer()
          }.padding(10)
            .background(model.selectedGuild == guild.id ? accent.opacity(0.18) : .clear)
            .clipShape(RoundedRectangle(cornerRadius: 10))
        }.buttonStyle(.plain)
      }
      Spacer()
      Label(model.snapshot?.botName ?? "djscord bot", systemImage: "person.crop.circle")
        .font(.caption).foregroundStyle(.secondary)
      Button {
        model.run { try await model.startBot() }
      } label: {
        Label(model.connected ? "봇 업데이트 / 재시작" : "봇 시작", systemImage: "power")
          .frame(maxWidth: .infinity)
      }.disabled(model.busy)
      Button {
        model.run { try await model.stopBot() }
      } label: {
        Label("서버 종료", systemImage: "stop.circle")
          .frame(maxWidth: .infinity)
      }.disabled(model.busy || model.shuttingDown)
      Button("프로젝트 폴더 선택…") { model.chooseProject() }.buttonStyle(.link)
        .font(.caption).disabled(model.busy)
      Text(model.projectPath).font(.system(size: 10)).foregroundStyle(.tertiary)
        .lineLimit(2).help(model.projectPath)
    }.padding(20).frame(width: 210)
      .background(Color(nsColor: .controlBackgroundColor).opacity(0.5))
  }

  private var channelCard: some View {
    VStack(alignment: .leading, spacing: 14) {
      Label("방송 연결", systemImage: "antenna.radiowaves.left.and.right").font(.headline)
      HStack(spacing: 20) {
        Picker("음성 채널", selection: $model.voiceChannel) {
          Text("선택하세요").tag("")
          ForEach(model.guild?.voiceChannels ?? []) { Text($0.name).tag($0.id) }
        }
        Picker("알림 채널", selection: $model.textChannel) {
          Text("알림 없음").tag("")
          ForEach(model.guild?.textChannels ?? []) { Text("# " + $0.name).tag($0.id) }
        }
      }.disabled(model.busy)
    }.padding(20).background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 16))
  }

  private var broadcastCard: some View {
    VStack(alignment: .leading, spacing: 20) {
      HStack {
        Label("시스템 오디오", systemImage: "waveform").font(.headline)
        Spacer()
        Text(model.player?.systemAudio == true ? "● LIVE" : "AUDIO ONLY")
          .font(.system(size: 11, weight: .bold)).foregroundStyle(model.player?.systemAudio == true ? .red : accent)
      }
      HStack(spacing: 18) {
        Image(systemName: model.player?.systemAudio == true ? "waveform" : "desktopcomputer")
          .font(.system(size: 42)).foregroundStyle(accent).frame(width: 70)
        VStack(alignment: .leading, spacing: 6) {
          Text(model.player?.systemAudio == true ? "맥의 소리를 방송 중" : "시스템 소리를 함께 듣기")
            .font(.title3.bold())
          Text("선택한 앱 채널만 송출 · Core Audio")
            .font(.callout).foregroundStyle(.secondary)
        }
        Spacer()
      }
      HStack {
        Button { model.run { try await model.broadcast() } } label: {
          Label("방송 시작", systemImage: "dot.radiowaves.left.and.right")
            .padding(.horizontal, 12).padding(.vertical, 6)
        }.buttonStyle(.borderedProminent)
          .disabled(!canStart || model.player?.systemAudio == true || !model.audioChannels.contains(where: { $0.enabled }))
        Button { model.run { try await model.endBroadcast() } } label: {
          Label("방송 종료", systemImage: "stop.fill").padding(.vertical, 6)
        }.disabled(model.busy || model.player?.systemAudio != true)
        Spacer()
        if model.captureRunning {
          Label("앱별 믹서 실행 중", systemImage: "checkmark.circle.fill")
            .font(.caption).foregroundStyle(.green)
        }
      }
    }.padding(24).background(accent.opacity(0.08), in: RoundedRectangle(cornerRadius: 18))
      .overlay(RoundedRectangle(cornerRadius: 18).stroke(accent.opacity(0.25)))
  }

  private var appMixerCard: some View {
    VStack(alignment: .leading, spacing: 16) {
      HStack {
        Label("앱별 오디오 믹서", systemImage: "slider.horizontal.3").font(.headline)
        Spacer()
        Text("\(model.audioChannels.filter(\.enabled).count)개 채널 선택")
          .font(.caption).foregroundStyle(.secondary)
        Button(model.captureRunning ? "믹서 실행 중" : "믹서 준비") {
          model.run { try await model.startCapture() }
        }.disabled(model.busy || model.captureRunning || !model.audioChannels.contains(where: { $0.enabled }))
        Button { model.refreshAudioChannels() } label: { Image(systemName: "arrow.clockwise") }
          .buttonStyle(.plain).help("실행 중인 앱 새로고침")
      }
      if model.audioChannels.isEmpty {
        Text("Chrome이나 rekordbox 등 송출할 앱을 먼저 실행하세요.")
          .font(.callout).foregroundStyle(.secondary)
      } else {
        ScrollView {
          VStack(spacing: 12) {
            ForEach(model.audioChannels) { channel in
              HStack(spacing: 14) {
                if let icon = channel.icon {
                  Image(nsImage: icon).resizable().frame(width: 30, height: 30)
                } else {
                  Image(systemName: "app.fill").font(.title2).frame(width: 30)
                }
                VStack(alignment: .leading, spacing: 4) {
                  Text(channel.name).font(.callout.bold()).lineLimit(1)
                  Text(channel.enabled ? (model.captureRunning ? channel.status : "송출 준비") : "송출 제외")
                    .font(.system(size: 10)).foregroundStyle(.secondary)
                }.frame(width: 135, alignment: .leading)
                Toggle("\(channel.name) 송출", isOn: Binding(
                  get: { channel.enabled },
                  set: { model.updateAudioChannel(channel.id, enabled: $0) }
                )).toggleStyle(.switch).labelsHidden()
                  .help("이 앱의 소리를 방송에 포함")
                VStack(spacing: 5) {
                  Slider(value: Binding(
                    get: { channel.volume },
                    set: { model.updateAudioChannel(channel.id, volume: $0) }
                  ), in: 0...100, step: 1)
                    .disabled(!channel.enabled)
                    .accessibilityLabel("\(channel.name) 송출 볼륨")
                  MixerLevelMeter(level: channel.level)
                    .accessibilityLabel("\(channel.name) 오디오 레벨")
                }
                Text("\(Int(channel.volume))%")
                  .font(.caption).monospacedDigit().frame(width: 38)
              }.padding(10)
                .background(channel.enabled ? accent.opacity(0.1) : Color.clear,
                  in: RoundedRectangle(cornerRadius: 10))
            }
          }
        }.frame(height: min(240, CGFloat(model.audioChannels.count) * 68))
      }
      Text("켜둔 앱의 소리만 합쳐 송출합니다. 채널 볼륨은 맥에서 듣는 음량에 영향을 주지 않습니다.")
        .font(.caption).foregroundStyle(.secondary)
      if model.captureRunning && model.snapshot?.guilds.contains(where: { $0.player?.systemAudio == true }) != true {
        Button("캡처 종료") { model.stopCapture() }.buttonStyle(.link).font(.caption)
      }
    }.padding(20).background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 16))
  }

  private var musicCard: some View {
    VStack(alignment: .leading, spacing: 16) {
      HStack {
        Label("음악 플레이어", systemImage: "music.note").font(.headline)
        Spacer()
        Text("YouTube 검색 · URL 재생").font(.caption).foregroundStyle(.secondary)
      }
      HStack {
        TextField("곡 제목 또는 YouTube URL", text: $model.query)
          .textFieldStyle(.roundedBorder)
          .onSubmit { if canStart && !model.query.isEmpty { model.run { try await model.control("play") } } }
        Button("재생 / 추가") { model.run { try await model.control("play") } }
          .disabled(!canStart || model.query.trimmingCharacters(in: .whitespaces).isEmpty)
      }
      Divider()
      HStack {
        VStack(alignment: .leading, spacing: 4) {
          Text(model.player?.title ?? "재생 대기 중").font(.headline).lineLimit(1)
          Text(model.player?.author ?? "음악을 검색하거나 방송을 시작하세요.")
            .font(.caption).foregroundStyle(.secondary)
        }
        Spacer()
        Button { model.run { try await model.control(model.player?.paused == true ? "resume" : "pause") } } label: {
          Image(systemName: model.player?.paused == true ? "play.fill" : "pause.fill")
        }.help("일시정지 / 계속")
        Button { model.run { try await model.control("skip") } } label: { Image(systemName: "forward.end.fill") }
          .disabled(model.player?.systemAudio == true).help("다음 곡")
        Button { model.run { try await model.control("stop") } } label: { Image(systemName: "stop.fill") }.help("재생 종료")
      }.disabled(model.busy || model.player == nil || !model.connected)
      HStack {
        Image(systemName: "speaker.wave.2.fill").foregroundStyle(.secondary)
        Slider(value: $model.volume, in: 0...100, step: 1) { editing in
          if !editing { model.run { try await model.control("volume", volume: Int(model.volume)) } }
        }.disabled(model.busy || model.player == nil || !model.connected)
        Text("\(Int(model.volume))%").monospacedDigit().frame(width: 45)
      }
      if let queue = model.player?.queue, !queue.isEmpty {
        Text("다음 곡 · \(queue.count)").font(.caption.bold()).foregroundStyle(.secondary)
        ForEach(Array(queue.prefix(5).enumerated()), id: \.offset) { index, title in
          Text("\(index + 1). \(title)").font(.callout).lineLimit(1)
        }
      }
    }.padding(20).background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 16))
  }

  private var canStart: Bool {
    model.connected && model.snapshot?.audioReady == true && !model.busy && !model.voiceChannel.isEmpty
  }
}

struct MixerLevelMeter: View {
  let level: Double
  private let segments = 24

  var body: some View {
    GeometryReader { geometry in
      HStack(spacing: 2) {
        ForEach(0..<segments, id: \.self) { index in
          let upperDB = AudioMeterScale.floorDB + Double(index + 1) * 60 / Double(segments)
          let color: Color = upperDB <= -12 ? .green : (upperDB <= -3 ? .yellow : .red)
          let lit = AudioMeterScale.fraction(level) > Double(index) / Double(segments)
          RoundedRectangle(cornerRadius: 1)
            .fill(color.opacity(lit ? 1 : 0.12))
            .frame(width: max(0, (geometry.size.width - CGFloat(segments - 1) * 2) / CGFloat(segments)))
        }
      }
    }
    .frame(height: 10)
    .transaction { transaction in
      transaction.animation = nil
      transaction.disablesAnimations = true
    }
    .accessibilityElement(children: .ignore)
    .accessibilityValue(level > 0 ? "\(Int(AudioMeterScale.decibels(level))) dBFS" : "무음")
    .help("초록: −12dB 미만 · 노랑: −12~−3dB · 빨강: −3~0dB (최대 레벨 근처)")
  }
}

@main
struct DjscordStudioApp: App {
  @NSApplicationDelegateAdaptor(StudioAppDelegate.self) private var delegate
  @StateObject private var model = StudioModel()

  var body: some Scene {
    WindowGroup("djscord Studio") {
      StudioView(model: model).preferredColorScheme(.dark)
        .onAppear { delegate.model = model }
    }
      .defaultSize(width: 1020, height: 760)
      .windowResizability(.contentMinSize)
  }
}

@MainActor
final class StudioAppDelegate: NSObject, NSApplicationDelegate {
  weak var model: StudioModel?
  private var terminationPending = false

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    guard !terminationPending else { return .terminateLater }
    guard let model else { return .terminateNow }
    terminationPending = true
    Task {
      do {
        try await model.prepareToQuit()
        sender.reply(toApplicationShouldTerminate: true)
      } catch {
        terminationPending = false
        model.error = error.localizedDescription
        sender.reply(toApplicationShouldTerminate: false)
        let alert = NSAlert()
        alert.messageText = "서버를 종료하지 못했습니다."
        alert.informativeText = error.localizedDescription + "\n서버가 남아 있을 수 있어 앱 종료를 취소했습니다. Docker 상태를 확인한 뒤 다시 종료해주세요."
        alert.runModal()
      }
    }
    return .terminateLater
  }
}
