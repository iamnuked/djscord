# djscord 웹사이트

한국어·영어로 봇 기능과 명령어, 커뮤니티를 소개하는 공개 랜딩 페이지입니다.

## 로컬 실행

```bash
pnpm install --frozen-lockfile
cp .env.example .env
pnpm dev
```

`NEXT_PUBLIC_DISCORD_COMMUNITY_URL`에 커뮤니티 초대 주소를 설정합니다.

## 검증

```bash
pnpm exec tsc --noEmit
pnpm run lint
pnpm test
```

`pnpm test`는 프로덕션 빌드와 실제 HTML 응답을 검사합니다.

## 라이선스와 배포물

웹 자체 코드는 `LICENSE`의 MIT 조건을 따릅니다. 빌드는 실제 포함 모듈의 라이선스 원문과 Geist 폰트의 OFL을 `dist/client/legal/`과 `dist/server/legal/`에 생성합니다. `/legal/third-party-notices.txt`, `/legal/Geist-OFL.txt`에서 사용자가 확인할 수 있으며 웹 하단에도 링크가 있습니다. 새로운 MPL/LGPL 등의 코드나 네이티브/WASM 바이너리가 포함되면 검토 전까지 빌드를 중단합니다.

로컬 `public/og.png`는 Git과 Docker 빌드 컨텍스트에서 제외하고, 웹 빌드에서도 복사하지 않습니다. 다른 공개 정적 파일을 추가하려면 현재 `publicDir: false` 설정을 고려하여 명시적으로 빌드에 포함해야 합니다.
