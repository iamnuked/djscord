# 제3자 소프트웨어 고지

djscord의 자체 코드는 루트 `LICENSE`의 MIT 조건을 따릅니다. 아래 외부 코드는 각 원래 라이선스를 유지하며, djscord의 MIT 라이선스로 대체되지 않습니다.

## 봇

실행 라이브러리의 버전·라이선스·원문은 다음 파일에 포함됩니다.

- `licenses/bot/packages.json`
- `licenses/bot/THIRD_PARTY_NOTICES.txt`

`npm run build` 또는 `npm run licenses:generate`가 설치된 실행 의존성을 추적해 이 파일을 갱신합니다. 새로운 라이선스나 원문 누락이 발견되면 자동 생성을 중단하여 검토하도록 합니다. 원래 `node_modules` 안의 고지도 그대로 보존해야 합니다. 배포용 Docker 이미지에는 이 문서와 `licenses/` 및 자체 `LICENSE`가 포함됩니다.

AWS 배포용 릴리스 압축 파일에도 `LICENSE`, 이 문서 및 `licenses/`를 포함합니다. 의존성 버전을 변경했다면 빌드로 갱신된 고지도 함께 커밋해야 합니다.

`@sapphire/async-queue@1.5.5`와 `@sapphire/snowflake@3.5.5`의 설치 패키지는 MIT라고 명시하지만 라이선스 파일을 담고 있지 않아, 공식 저장소의 `licenses/sapphire-utilities-LICENSE.md`를 함께 제공합니다.

## 웹사이트

웹 빌드는 실제 번들에 남는 모듈을 추적하여 `dist/client/legal/` 및 `dist/server/legal/`에 다음을 생성합니다.

- `third-party-packages.json`: 실제 포함된 패키지 버전과 라이선스
- `third-party-notices.txt`: 해당 패키지의 라이선스·저작권·NOTICE 원문
- `Geist-OFL.txt`: Geist 및 Geist Mono의 SIL Open Font License 1.1
- `LICENSE.txt`: 웹 자체 코드의 MIT 라이선스

사용자는 웹 하단의 **오픈소스 고지**, **폰트 라이선스** 링크를 통해 원문을 볼 수 있습니다. 폰트 원문은 저장소의 `website/legal/Geist-OFL.txt`에도 보관합니다.

웹 빌드 도구 중에는 MPL-2.0인 Lightning CSS·Satori·resvg, LGPL인 sharp/libvips 관련 패키지가 있습니다. 개발 의존성이라는 표기만으로 배포에서 제외됐다고 판단하지 않습니다. 실제 포함된 패키지는 위 번들 목록으로 확인하며, 새 MPL/LGPL 등의 런타임 코드가 포함되면 고지·대응 소스 등 필요한 조치를 검토하기 전까지 빌드가 중단됩니다. 이 중단은 사용 금지를 뜻하지 않습니다.

개발 도구의 `node_modules`, 빌드 캐시, 테스트 이미지는 일반 배포물에 포함하지 않습니다. 이 파일들을 별도로 재배포하는 경우 해당 패키지와 네이티브 하위 라이브러리의 원문 및 소스 제공·교체 관련 조건을 별도로 충족해야 합니다.

## Lavalink와 YouTube 소스

Compose가 공식 서버 이미지와 플러그인을 내려받아 별도 실행합니다. 고정 버전의 프로젝트 라이선스는 MIT입니다.

- Lavalink 4.2.2: `licenses/Lavalink-MIT.txt` — <https://github.com/lavalink-devs/Lavalink/blob/4.2.2/LICENSE>
- YouTube source `34ee4c5f6b4608c19880ff62f80540c0048f537e`: `licenses/YouTube-Source-MIT.txt` — <https://github.com/lavalink-devs/youtube-source/blob/34ee4c5f6b4608c19880ff62f80540c0048f537e/LICENSE>

각 프로젝트의 MIT 라이선스가 Docker 기반 OS·JVM·모든 하위 구성요소까지 MIT라는 뜻은 아닙니다. 공식 이미지를 참고하여 실행하는 것과 이미지를 별도 재배포하는 것은 구분해야 합니다. 이미지를 수정하거나 별도 재배포하면 원본 이미지의 구성요소별 고지와 의무도 유지해야 합니다.

## macOS 앱과 이미지

macOS 앱은 운영체제의 AppKit·SwiftUI·CoreAudio·Security 등 시스템 프레임워크를 참조하며, 이 저장소는 해당 프레임워크의 바이너리나 Apple SDK를 포함하지 않습니다. 앱 번들에는 자체 MIT 라이선스와 이 고지, `licenses/`가 포함됩니다.

Git에서 제외한 앱 아이콘과 웹 이미지는 기본 배포 빌드에서도 제외합니다. 웹은 로컬 `public/` 폴더를 복사하지 않고, 앱은 기본 아이콘을 사용합니다. 앱에서 `DJSCORD_INCLUDE_LOCAL_ARTWORK=1`을 명시하면 로컬 아이콘을 포함할 수 있지만, 해당 이미지의 이용 권한을 확인한 경우에만 사용해야 합니다.

코드 라이선스는 외부 음원·이미지·상표의 이용 권한을 부여하지 않습니다.

## 원문 출처

원문을 내려받은 날짜: 2026-10-21.

- Geist OFL: <https://github.com/vercel/geist-font/blob/main/OFL.txt>, Git blob `04e95fc550855eb44416b9db1f6722f5cb7342db`
- Sapphire MIT: <https://github.com/sapphiredev/utilities/blob/main/LICENSE.md>, Git blob `685eb3a186a514b7423eb1d3730f3fb9f000575d`
- Lavalink MIT: 위 4.2.2 태그, Git blob `506d8d1305d71274182bf8f211d673eb5f56cbca`
- YouTube source MIT: 위 고정 커밋, Git blob `1086cf77fea915324b249a432ad1942e407c12e3`
- 웹에서 복사하여 사용하는 Sites 플러그인의 원문: `website/scripts/vite/sites-vite-plugin.LICENSE`
- Vite RSC 런타임 헬퍼의 원문: `website/legal/Vite-Plugin-React-MIT.txt` — <https://github.com/vitejs/vite-plugin-react/blob/main/LICENSE>, Git blob `9c1b313d7b18166024d52473b2ed645f5b4e64dd`. 설치된 `@vitejs/plugin-rsc@0.5.26`에 빠진 원문을 같은 공식 저장소의 `@vitejs/plugin-react` 패키지와 대조하여 보완했습니다.
