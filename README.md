# Trost Vacation Bot

매주 월요일 오전 9시(KST)에 `#넋지_자리비움` 채널의 flex 봇 메시지를 파싱해서, 지정된 슬랙 User Group 멤버의 **이번 주(오늘 ~ 7일 후)** 휴가 일정을 타겟 채널에 스레드로 공유하는 봇.

- 언어: TypeScript (tsx로 빌드 없이 실행)
- 실행 환경: GitHub Actions (cron)

## 동작 방식

1. 슬랙 User Group 멤버 ID 목록 조회 → 멤버들의 표시 이름 수집 (real_name / display_name)
2. 소스 채널(`SLACK_SOURCE_CHANNEL_ID`)의 최근 60일치 메시지 조회
3. flex 봇 메시지 파싱
   - 등록: `:palm_tree: [이름] - 5월 8일 ~ 5월 12일 휴가입니다.`
   - 반차: `:palm_tree: [이름] - 5월 8일 오후 1:30 ~ 오후 5:30 휴가입니다.`
   - 전일: `:palm_tree: [이름] - 5월 8일 하루종일 휴가입니다.`
   - 취소: `:exclamation: [이름] - ... 휴가가 취소되었습니다.` → 동일 키 등록 무효화
4. 멤버 이름 + 날짜(오늘 ~ 오늘+6일) 조건으로 필터
5. 타겟 채널(`SLACK_TARGET_CHANNEL_ID`)에 부모 메시지 게시 후 스레드 답글로 상세 목록 게시

## 사전 준비

### 1. Slack 앱 만들기

1. https://api.slack.com/apps → Create New App → From scratch
2. **OAuth & Permissions** → Bot Token Scopes에 다음 추가:
   - `channels:history` (소스 채널 메시지 읽기)
   - `chat:write` (타겟 채널에 메시지 게시)
   - `usergroups:read` (User Group 멤버 조회)
   - `users:read` (멤버 이름 조회)
3. Install to Workspace → `Bot User OAuth Token` (`xoxb-...`) 복사
4. 봇을 두 채널에 모두 초대: `/invite @봇이름`
   - 소스: `#넋지_자리비움` (`C01RYV15VV5`)
   - 타겟: `C01HGG52PC1`

> 소스 채널이 비공개라면 추가로 `groups:history` 스코프 필요.

### 2. User Group ID 확인

```bash
SLACK_BOT_TOKEN=xoxb-xxx npm run list-groups
```

출력 예시:
```
id      : S0XXXXXXXX
name    : 트로스트
handle  : @trost
members : 25
```

원하는 그룹의 `id` (S로 시작)를 `SLACK_USER_GROUP_ID`로 사용.

### 3. GitHub Secrets 등록

레포지토리 Settings → Secrets and variables → Actions:

- `SLACK_BOT_TOKEN`
- `SLACK_SOURCE_CHANNEL_ID` (`C01RYV15VV5`)
- `SLACK_TARGET_CHANNEL_ID` (`C01HGG52PC1`)
- `SLACK_USER_GROUP_ID`

## 로컬 테스트

```bash
npm install
cp .env.example .env       # 값 채우기
npm run typecheck          # 타입 체크
npm test                   # 파서 단위 테스트
npm run dry-run            # 슬랙 발송 없이 콘솔 출력만 (.env 자동 로드)
npm start                  # 실제 발송
```

> `.env` 파일은 Node 20의 `--env-file` 옵션으로 로드. tsx도 동일하게 인식.
> 만약 미적용되면 `node --env-file=.env --import tsx src/index.ts` 로 직접 실행.

### 수동 트리거

GitHub Actions의 `workflow_dispatch` 로 dry-run 실행 가능:
Actions 탭 → `Weekly Vacation Notifier` → Run workflow → `dry_run: true`

## 실행 시각 변경

[.github/workflows/weekly-vacation.yml](.github/workflows/weekly-vacation.yml) 의 `cron` 값 수정 (UTC 기준).

| 원하는 KST | cron (UTC) |
|---|---|
| 월요일 09:00 (현재) | `0 0 * * 1` |
| 월요일 10:00 | `0 1 * * 1` |
| 매일 09:00 | `0 0 * * *` |
| 금요일 17:00 | `0 8 * * 5` |

## 파일 구조

```
.
├── .github/workflows/weekly-vacation.yml   # GitHub Actions 크론
├── src/
│   ├── index.ts                            # 메인 엔트리
│   └── parser.ts                           # flex 메시지 파서
├── scripts/
│   └── list-user-groups.ts                 # User Group ID 조회 헬퍼
├── test/
│   └── parser.test.ts                      # 파서 단위 테스트
├── tsconfig.json
├── package.json
├── .env.example
└── README.md
```

## 알려진 제약

- flex 봇이 메시지에 적는 `[이름]` 텍스트와 슬랙 사용자 프로필의 `real_name` / `display_name` / `name` 중 하나가 일치해야 매칭됨. 동명이인 처리(예: `김준우A`, `김준우B`)는 슬랙 표시 이름에도 동일하게 들어가 있어야 함.
- 60일보다 오래된 장기 휴가는 `LOOKBACK_DAYS` 환경변수로 늘려야 함.
- 휴가 등록 메시지에 연도가 없어 메시지 작성 시점 기준 가장 가까운 미래 날짜로 추정 (테스트 케이스 참고).
