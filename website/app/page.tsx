"use client";

import { useEffect, useSyncExternalStore } from "react";

type Locale = "ko" | "en";

const communityUrl = process.env.NEXT_PUBLIC_DISCORD_COMMUNITY_URL?.trim();

const copy = {
  ko: {
    nav: { features: "기능", how: "시작하기", commands: "명령어", faq: "FAQ" },
    status: "현재 열심히 조율 중 · 곧 공개",
    eyebrow: "당신의 서버를 위한 음악 봇",
    titleLead: "우리 서버의 분위기를",
    titleAccent: "음악으로 이어주세요.",
    intro: "검색부터 장르 플레이리스트, 자동 추천까지. djscord가 대화의 흐름을 끊지 않고 모두의 다음 곡을 이어갑니다.",
    community: "커뮤니티 참여하기",
    pending: "커뮤니티 준비 중",
    explore: "기능 둘러보기",
    highlights: ["한국어 명령어", "최대 100곡 대기열", "개인 플레이리스트"],
    nowPlaying: "지금 재생 중",
    track: "Afterglow Drive",
    artist: "djscord radio · 3:42",
    queue: "다음 곡",
    queueCount: "12곡",
    listeners: "함께 듣는 중",
    autoplay: "자동재생 켜짐",
    featureEyebrow: "FEATURES",
    featureTitle: "음악은 더 가깝게,\n조작은 더 간단하게.",
    featureIntro: "복잡한 설정 없이 음성 채널에 들어가 명령어 하나만 입력하세요.",
    features: [
      { icon: "✦", tag: "GENRE MIX", title: "장르만 말하면, 선곡은 djscord가", text: "K-pop, 재즈, 2000년대 록까지. 대표 아티스트와 Mix를 조합해 한쪽으로 치우치지 않는 플레이리스트를 만듭니다.", sample: "/장르 이름:재즈 곡수:20" },
      { icon: "↻", tag: "AUTOPLAY", title: "대화가 계속되는 동안 음악도 계속", text: "대기열이 끝나면 마지막 곡을 바탕으로 자연스럽게 다음 음악을 추천합니다." },
      { icon: "♥", tag: "MY MUSIC", title: "좋았던 곡은 내 음악에", text: "좋아요 한 곡과 현재 대기열을 개인 즐겨찾기·플레이리스트로 안전하게 보관하세요." },
      { icon: "⌁", tag: "SMART QUEUE", title: "서버마다 독립적인 대기열", text: "셔플, 반복, 순서 이동, 볼륨까지 채팅 속 플레이어에서 함께 제어합니다." },
    ],
    howEyebrow: "HOW IT WORKS",
    howTitle: "세 단계면 충분해요.",
    howIntro: "누구나 바로 시작할 수 있도록 Discord 안에서 모든 과정이 끝납니다.",
    steps: [
      { n: "01", title: "음성 채널에 들어가기", text: "친구들이 모인 음성 채널에 먼저 입장하세요." },
      { n: "02", title: "듣고 싶은 곡 말하기", text: "곡명이나 YouTube 링크를 /재생 명령에 입력하세요." },
      { n: "03", title: "함께 듣고 조율하기", text: "플레이어 버튼으로 스킵하고, 좋아요로 다음 추천을 알려주세요." },
    ],
    commandsEyebrow: "COMMANDS",
    commandsTitle: "하고 싶은 말을 그대로.",
    commandsIntro: "20개의 한국어 슬래시 명령으로 재생부터 나만의 플레이리스트까지 관리할 수 있습니다.",
    commands: [
      ["/재생", "곡명, 영상 URL 또는 재생목록을 찾아 재생합니다."],
      ["/장르", "원하는 장르와 곡 수로 새 목록을 만듭니다."],
      ["/자동재생", "관련 음악이 계속 이어지도록 설정합니다."],
      ["/플레이리스트", "현재 대기열을 저장하고 다시 불러옵니다."],
      ["/대기열", "현재 곡과 다음 10곡을 확인합니다."],
      ["/사용법", "모든 명령과 플레이어 사용법을 확인합니다."],
    ],
    allCommands: "그 밖에도 /일시정지 · /스킵 · /반복 · /셔플 · /볼륨 등을 지원합니다.",
    faqEyebrow: "FAQ",
    faqTitle: "궁금한 점이 있나요?",
    faqs: [
      ["지금 바로 서버에 초대할 수 있나요?", "아직 공개 준비 중입니다. Discord 커뮤니티가 열리면 테스트 일정과 초대 방법을 가장 먼저 안내할 예정입니다."],
      ["재생 기록과 플레이리스트는 유지되나요?", "서버 설정, 개인 즐겨찾기, 저장한 플레이리스트와 추천 피드백은 유지됩니다. 현재 재생 중인 곡과 대기열은 봇이 재시작되면 초기화됩니다."],
      ["어떤 음악을 재생할 수 있나요?", "곡명 검색, YouTube 영상 URL과 최대 50곡의 YouTube 재생목록을 지원합니다. 외부 서비스 상태와 정책에 따라 일부 재생이 제한될 수 있습니다."],
      ["봇이 음성 채널에 계속 남아 있나요?", "대기열이 비거나 청취자가 없는 상태가 5분간 이어지면 자동으로 퇴장합니다."],
    ],
    ctaEyebrow: "EARLY ACCESS",
    ctaTitle: "다음 재생 버튼을\n함께 눌러주세요.",
    ctaText: "djscord의 공개 테스트와 업데이트 소식을 커뮤니티에서 가장 먼저 만나보세요.",
    footer: "서버의 순간을 음악으로 잇는 Discord 음악 봇.",
    unofficial: "djscord는 Discord 또는 YouTube와 제휴하거나 보증받은 서비스가 아닙니다.",
  },
  en: {
    nav: { features: "Features", how: "How it works", commands: "Commands", faq: "FAQ" },
    status: "Tuning in progress · Coming soon",
    eyebrow: "A music bot for your server",
    titleLead: "Keep your server together",
    titleAccent: "one track at a time.",
    intro: "From search and genre playlists to endless recommendations, djscord keeps the next song flowing without interrupting the conversation.",
    community: "Join the community",
    pending: "Community coming soon",
    explore: "Explore features",
    highlights: ["Korean-first commands", "Up to 100 tracks", "Personal playlists"],
    nowPlaying: "Now playing",
    track: "Afterglow Drive",
    artist: "djscord radio · 3:42",
    queue: "Up next",
    queueCount: "12 tracks",
    listeners: "Listening together",
    autoplay: "Autoplay on",
    featureEyebrow: "FEATURES",
    featureTitle: "Music closer.\nControls simpler.",
    featureIntro: "Join a voice channel and start with one command—no complicated setup.",
    features: [
      { icon: "✦", tag: "GENRE MIX", title: "Name a genre. We’ll set the mood.", text: "From K-pop and jazz to 2000s rock, djscord blends representative artists and mixes into a balanced playlist.", sample: "/장르 이름:재즈 곡수:20" },
      { icon: "↻", tag: "AUTOPLAY", title: "The conversation flows. So does the music.", text: "When the queue ends, recommendations based on the last track keep everyone listening." },
      { icon: "♥", tag: "MY MUSIC", title: "Save every track worth replaying.", text: "Keep favorites and the current queue in your own persistent music collection." },
      { icon: "⌁", tag: "SMART QUEUE", title: "A queue for every server.", text: "Shuffle, loop, reorder, and change volume together from the player in chat." },
    ],
    howEyebrow: "HOW IT WORKS",
    howTitle: "Three steps. That’s it.",
    howIntro: "Everything happens inside Discord, so anyone can start listening right away.",
    steps: [
      { n: "01", title: "Join a voice channel", text: "Hop into the voice channel where your friends are hanging out." },
      { n: "02", title: "Ask for a track", text: "Enter a song title or YouTube link with the /재생 command." },
      { n: "03", title: "Listen and shape the mix", text: "Skip with player controls and use feedback to tune the next recommendation." },
    ],
    commandsEyebrow: "COMMANDS",
    commandsTitle: "Say what you want to hear.",
    commandsIntro: "Twenty Korean slash commands cover everything from playback to your own saved playlists.",
    commands: [
      ["/재생", "Search and play a title, video URL, or playlist."],
      ["/장르", "Build a new mix from a genre and track count."],
      ["/자동재생", "Keep related music playing after the queue ends."],
      ["/플레이리스트", "Save the current queue and bring it back later."],
      ["/대기열", "See the current track and the next ten songs."],
      ["/사용법", "Open the complete command and player guide."],
    ],
    allCommands: "Also supports /일시정지 · /스킵 · /반복 · /셔플 · /볼륨 and more.",
    faqEyebrow: "FAQ",
    faqTitle: "A few things to know.",
    faqs: [
      ["Can I invite the bot now?", "djscord is still preparing for public release. Join the Discord community when it opens for test dates and invite details."],
      ["Are my playlists kept?", "Server settings, favorites, saved playlists, and recommendation feedback persist. The active track and queue reset when the bot restarts."],
      ["What can it play?", "Search by title, use a YouTube video URL, or add a YouTube playlist with up to 50 tracks. Availability may vary with external service status and policies."],
      ["Does it stay in voice forever?", "It leaves automatically after five minutes with an empty queue or no listeners."],
    ],
    ctaEyebrow: "EARLY ACCESS",
    ctaTitle: "Be there when we\nhit play.",
    ctaText: "Join the community to hear about djscord’s public test and release updates first.",
    footer: "A Discord music bot that connects every server moment with music.",
    unofficial: "djscord is not affiliated with or endorsed by Discord or YouTube.",
  },
} as const;

function detectLocale(): Locale {
  if (typeof window === "undefined") return "ko";
  const saved = window.localStorage.getItem("djscord-locale");
  if (saved === "ko" || saved === "en") return saved;
  return window.navigator.language.toLowerCase().startsWith("ko") ? "ko" : "en";
}

function subscribeToLocale(onStoreChange: () => void) {
  window.addEventListener("storage", onStoreChange);
  window.addEventListener("djscord-locale", onStoreChange);
  return () => {
    window.removeEventListener("storage", onStoreChange);
    window.removeEventListener("djscord-locale", onStoreChange);
  };
}

export default function Home() {
  const locale = useSyncExternalStore<Locale>(subscribeToLocale, detectLocale, () => "ko");
  const t = copy[locale];

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const changeLocale = (nextLocale: Locale) => {
    window.localStorage.setItem("djscord-locale", nextLocale);
    window.dispatchEvent(new Event("djscord-locale"));
  };

  return (
    <div className="site-shell">
      <a className="skip-link" href="#main">Skip to content</a>
      <header className="site-header">
        <a className="brand" href="#top" aria-label="djscord home">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <span>djscord</span>
        </a>
        <nav className="desktop-nav" aria-label="Main navigation">
          <a href="#features">{t.nav.features}</a>
          <a href="#how">{t.nav.how}</a>
          <a href="#commands">{t.nav.commands}</a>
          <a href="#faq">{t.nav.faq}</a>
        </nav>
        <div className="locale-switch" role="group" aria-label="Language">
          <button className={locale === "ko" ? "active" : ""} onClick={() => changeLocale("ko")} aria-pressed={locale === "ko"}>KO</button>
          <span aria-hidden="true">/</span>
          <button className={locale === "en" ? "active" : ""} onClick={() => changeLocale("en")} aria-pressed={locale === "en"}>EN</button>
        </div>
      </header>

      <main id="main">
        <section className="hero" id="top">
          <div className="hero-copy">
            <div className="status-pill"><span aria-hidden="true" />{t.status}</div>
            <p className="eyebrow">{t.eyebrow}</p>
            <h1>{t.titleLead}<br /><em>{t.titleAccent}</em></h1>
            <p className="hero-intro">{t.intro}</p>
            <div className="hero-actions">
              {communityUrl ? (
                <a className="primary-button" href={communityUrl} target="_blank" rel="noreferrer">{t.community}<span aria-hidden="true">↗</span></a>
              ) : (
                <span className="primary-button disabled" aria-disabled="true">{t.pending}<span aria-hidden="true">◌</span></span>
              )}
              <a className="text-button" href="#features">{t.explore}<span aria-hidden="true">↓</span></a>
            </div>
            <ul className="hero-highlights" aria-label="Highlights">
              {t.highlights.map((item) => <li key={item}><span aria-hidden="true">✓</span>{item}</li>)}
            </ul>
          </div>

          <div className="hero-visual" aria-label="djscord player preview">
            <div className="ambient ambient-one" /><div className="ambient ambient-two" />
            <div className="player-card">
              <div className="player-topline"><span className="live-dot" />{t.nowPlaying}<span className="wave" aria-hidden="true"><i /><i /><i /><i /></span></div>
              <div className="album-art"><span className="disc" /><span className="album-monogram">dj</span><span className="album-label">NIGHT DRIVE<br />SELECTIONS</span></div>
              <div className="track-row">
                <div><strong>{t.track}</strong><span>{t.artist}</span></div>
                <button className="heart-button" aria-label="Save track">♥</button>
              </div>
              <div className="progress" aria-label="Playback progress"><span /><i /></div>
              <div className="time-row"><span>1:08</span><span>-2:34</span></div>
              <div className="controls" aria-hidden="true"><button>↻</button><button>‹‹</button><button className="play">▶</button><button>››</button><button>⌁</button></div>
            </div>
            <div className="queue-card">
              <div className="queue-heading"><div><span>{t.queue}</span><strong>{t.queueCount}</strong></div><span className="queue-icon" aria-hidden="true">≡</span></div>
              {["Midnight City", "Bam Yang Gang", "Plastic Love"].map((name, index) => (
                <div className="queue-track" key={name}><span>{String(index + 1).padStart(2, "0")}</span><div><strong>{name}</strong><small>{["M83", "BIBI", "Mariya Takeuchi"][index]}</small></div><i>•••</i></div>
              ))}
              <div className="queue-footer"><span>●●● <b>+3</b> {t.listeners}</span><strong>✦ {t.autoplay}</strong></div>
            </div>
          </div>
        </section>

        <section className="section features-section" id="features">
          <div className="section-heading"><div><p className="section-eyebrow">{t.featureEyebrow}</p><h2>{t.featureTitle.split("\n").map((line) => <span key={line}>{line}</span>)}</h2></div><p>{t.featureIntro}</p></div>
          <div className="feature-grid">
            {t.features.map((feature, index) => (
              <article className={`feature-card feature-${index + 1}`} key={feature.tag}>
                <div className="feature-icon" aria-hidden="true">{feature.icon}</div>
                <p className="card-tag">{feature.tag}</p><h3>{feature.title}</h3><p>{feature.text}</p>
                {"sample" in feature && <code>{feature.sample}</code>}
                {index === 1 && <div className="mini-autoplay"><span>✦</span><div><strong>AUTO DJ</strong><small>{locale === "ko" ? "추천 트랙 준비 완료" : "Next track ready"}</small></div><i /></div>}
                {index === 2 && <div className="saved-tracks"><span>♫</span><span>♫</span><span>♫</span><b>+24</b></div>}
              </article>
            ))}
          </div>
        </section>

        <section className="section how-section" id="how">
          <div className="center-heading"><p className="section-eyebrow">{t.howEyebrow}</p><h2>{t.howTitle}</h2><p>{t.howIntro}</p></div>
          <div className="steps">
            {t.steps.map((step, index) => <article className="step" key={step.n}><div className="step-number">{step.n}</div><div className="step-visual" aria-hidden="true">{index === 0 ? "◉" : index === 1 ? "/재생" : "♫"}</div><h3>{step.title}</h3><p>{step.text}</p></article>)}
          </div>
        </section>

        <section className="section commands-section" id="commands">
          <div className="commands-copy"><p className="section-eyebrow">{t.commandsEyebrow}</p><h2>{t.commandsTitle}</h2><p>{t.commandsIntro}</p><div className="command-prompt"><span>⌕</span><code>/장르 이름:K-pop 곡수:20</code><i>↵</i></div></div>
          <div className="command-list">
            {t.commands.map(([command, description]) => <div className="command-row" key={command}><code>{command}</code><p>{description}</p><span aria-hidden="true">→</span></div>)}
            <p className="all-commands">{t.allCommands}</p>
          </div>
        </section>

        <section className="section faq-section" id="faq">
          <div className="faq-title"><p className="section-eyebrow">{t.faqEyebrow}</p><h2>{t.faqTitle}</h2></div>
          <div className="faq-list">{t.faqs.map(([question, answer], index) => <details key={question} open={index === 0}><summary>{question}<span aria-hidden="true">+</span></summary><p>{answer}</p></details>)}</div>
        </section>

        <section className="final-cta">
          <div className="cta-orbit orbit-one" /><div className="cta-orbit orbit-two" />
          <p className="section-eyebrow">{t.ctaEyebrow}</p><h2>{t.ctaTitle.split("\n").map((line) => <span key={line}>{line}</span>)}</h2><p>{t.ctaText}</p>
          {communityUrl ? <a className="primary-button light" href={communityUrl} target="_blank" rel="noreferrer">{t.community}<span aria-hidden="true">↗</span></a> : <span className="primary-button light disabled" aria-disabled="true">{t.pending}<span aria-hidden="true">◌</span></span>}
        </section>
      </main>

      <footer className="site-footer"><div><a className="brand" href="#top"><span className="brand-mark" aria-hidden="true"><i /><i /><i /></span><span>djscord</span></a><p>{t.footer}</p></div><p>{t.unofficial}</p><span>© 2026 djscord · <a href="/legal/third-party-notices.txt">{locale === "ko" ? "오픈소스 고지" : "Open source notices"}</a> · <a href="/legal/Geist-OFL.txt">{locale === "ko" ? "폰트 라이선스" : "Font license"}</a></span></footer>
    </div>
  );
}
