# BoB 15기 강의실 예약 — 백엔드 버전

기존 클로드 아티팩트(브라우저 저장소)를 실제 서버 + 데이터베이스로 옮긴 버전입니다.
이제 예약 검증(비밀번호, 주간 제한, 취소·노쇼 페널티, 당일 취소 금지, 관리자 비밀번호)이
**전부 서버에서 처리**되어, 브라우저 개발자도구로 우회할 수 없습니다.

## 로컬에서 실행해보기

```bash
npm install
npm start
```

`http://localhost:3000` 접속. 데이터는 `data/db.json`에 저장됩니다 (최초 실행 시 자동 생성).

## 환경변수 (선택)

| 변수 | 기본값 | 설명 |
|---|---|---|
| `PORT` | 3000 | 서버 포트 (Railway가 자동으로 설정해줌) |
| `ADMIN_PASSCODE` | bob15admin | CSV 내보내기·노쇼 처리에 필요한 운영진 비밀번호 — **꼭 바꿔서 배포하세요** |
| `MIN_BOOKING_DATE` | 2026-08-31 | 예약 접수 시작일 |
| `DATA_DIR` | ./data | 데이터 파일이 저장될 폴더 |

## Railway 배포 방법

1. **GitHub에 이 폴더를 레포로 올리기**
   ```bash
   git init
   git add .
   git commit -m "BoB 15기 강의실 예약 백엔드"
   git branch -M main
   git remote add origin https://github.com/<계정명>/<레포명>.git
   git push -u origin main
   ```

2. **Railway에서 새 프로젝트 생성 후 이 GitHub 레포 연결**
   - Railway 대시보드 → New Project → Deploy from GitHub repo → 방금 만든 레포 선택
   - 자동으로 Node.js 프로젝트로 인식하고 `npm install && npm start`로 빌드/실행됩니다.

3. **환경변수 설정**
   - Railway 서비스 → Variables 탭에서 `ADMIN_PASSCODE`를 원하는 값으로 설정하세요.
   - `MIN_BOOKING_DATE`도 필요하면 바꾸세요 (예: 다음 기수 때 날짜 변경).

4. **볼륨 연결 (데이터 유지를 위해 꼭 필요)**
   - Railway 서비스 → Settings → Volumes → Add Volume
   - Mount path를 `/data`로 지정
   - 환경변수에 `DATA_DIR=/data` 추가
   - **이 단계를 건너뛰면 재배포할 때마다 예약 데이터가 초기화돼요.**

5. **도메인 확인**
   - Settings → Networking → Generate Domain으로 공개 URL을 받을 수 있어요.
   - 이 URL은 클로드 계정 없이 누구나 접속 가능합니다.

## 기존 버전과 달라진 점

- 모든 검증 로직(비밀번호, 주간 5타임 제한, 취소·노쇼 3회 누적 시 2주 제한, 당일 취소 금지,
  예약 접수 기간)이 서버에서 처리됩니다. 브라우저 콘솔로 우회 불가능합니다.
- 관리자 비밀번호(`ADMIN_PASSCODE`)는 서버 환경변수로만 존재하고, 프론트엔드 코드에는
  전혀 노출되지 않습니다.
- "노쇼 처리"도 이제 운영진 비밀번호가 필요합니다 (기존 버전은 비밀번호 없이 가능했어요).
- 클로드 계정이 전혀 필요 없습니다 — 일반 웹사이트처럼 링크만 있으면 누구나 접속해요.
