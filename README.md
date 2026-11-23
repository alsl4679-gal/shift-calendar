# 교대달력

광고 없는 4조 2교대(주주휴휴야야휴휴) 근무 달력 PWA. 같은 공장·같은 반 동료끼리 휴가·대근을 실시간으로 공유합니다.

- 프론트엔드: HTML + JavaScript (빌드 과정 없음, GitHub Pages에 그대로 올리면 됨)
- 서버: Supabase 프로젝트 `shift-calendar` (서울 리전, 무료 플랜) — DB 구조는 이미 적용돼 있음

## 1. 처음 한 번: Supabase 설정 (필수)

Supabase 대시보드 → `shift-calendar` 프로젝트 → **Authentication** → 이메일 로그인 설정에서 **Confirm email** 을 끕니다.

- 켜 두면 가입할 때마다 인증 메일이 나가는데, 기본 메일 서버는 시간당 발송 수가 매우 적고 메일 속 링크도 `localhost`로 연결돼 동료들이 가입을 못 합니다.
- 메뉴 이름·위치는 Supabase 업데이트로 바뀔 수 있습니다.

## 2. 내 PC에서 실행해 보기

```bash
cd shift-calendar
python3 -m http.server 8000
# 브라우저에서 http://localhost:8000
```

> `index.html`을 더블클릭(file://)하면 모듈 로딩이 막혀서 동작하지 않습니다. 꼭 위처럼 서버로 여세요.

## 3. GitHub Pages 배포

```bash
cd shift-calendar
git init
git add .
git commit -m "교대달력 첫 버전"
gh repo create shift-calendar --public --source=. --push
```

그다음 GitHub 저장소 → **Settings → Pages** → Source: `Deploy from a branch`, Branch: `main` / `(root)` → Save.
1~2분 뒤 `https://<깃허브아이디>.github.io/shift-calendar/` 로 접속됩니다.

- `js/config.js`의 키는 **publishable 키**라 공개 저장소에 있어도 됩니다. 데이터는 DB의 RLS(행 단위 보안)로 같은 팀원에게만 보입니다.
- 절대 `service_role` 키나 `secret` 키는 넣지 마세요.

## 4. 사용 순서

1. 회원가입 → **새 팀 만들기**: 공장 이름, 반, 내 이름·조, "오늘 A조 근무"를 고르면 미리보기(오늘 주간 ○조 · 야간 ○조)가 나옵니다. 맞는지 꼭 확인하세요.
2. **내 정보** 탭 → 초대 코드 **공유** → 같은 반 동료에게 전달
3. 동료: 회원가입 → **초대 코드로 참여** → 이름·조 선택
4. 홈 화면에 추가: Android Chrome은 "앱 설치", iPhone은 Safari **공유 → 홈 화면에 추가**

## 5. 동작 규칙

| 상황 | 결과 |
|---|---|
| 내 달력에서 근무 변경 | 팀 달력에 바로 반영 (공개/비공개 선택 없음) |
| 근무일을 **휴가**로 변경 | 팀 달력에 "대근 필요" 자동 등록 |
| 휴무인 사람이 **대근 지원** | 지원자 목록에 추가 (그날 근무 있으면 지원 불가) |
| 휴가 등록자 또는 관리자가 **확정** | 대근자 개인 달력에 "대근" 자동 기입 |
| 휴가 취소 | 대근 요청 취소 + 확정된 대근자 근무도 원래대로 |
| 대근자가 그날 근무를 바꿈 | 대근 확정 해제 → 다시 "대근 필요" |
| 휴가 종류·메모 | 본인만 보임 (팀에는 "휴가"만 표시) |

- 팀을 만든 사람이 관리자. **내 정보 → 팀원 이름**을 눌러 주임 등을 관리자로 지정할 수 있습니다.
- 근무 기준일은 07:00. 새벽 6시에 열면 "오늘"은 전날(야간 근무 중)로 표시됩니다.

## 6. 파일 구조

```
index.html            화면 틀
css/style.css         디자인
js/shift.js           근무 계산(패턴·통계) — 화면과 분리돼 있어 나중에 Dart로 옮기기 쉬움
js/app.js             화면·Supabase 연동·실시간
js/config.js          Supabase 주소·키
vendor/supabase.js    supabase-js 2.119.2 (CDN 대신 내장 — 오프라인에서도 화면 로딩)
sw.js                 서비스 워커(오프라인 캐시)
manifest.webmanifest  PWA 설치 정보
supabase/schema.sql   DB 구조 사본 (프로젝트에는 이미 적용됨, 재구축용)
```

## 7. 현재 한계 (다음 작업 후보)

- **푸시 알림 없음**: 앱이 열려 있을 때만 새 휴가가 실시간 토스트로 뜹니다. 닫혀 있으면 다음에 열 때 반영.
- **비밀번호 찾기 없음**: 이메일 발송 설정(SMTP)이 필요해서 뺐습니다. 잊으면 Supabase 대시보드에서 사용자 삭제 후 재가입.
- **공휴일 표시 없음**, 통계는 근무표 기준 **참고용**(연장근무 미반영).
- **무료 플랜**: 일주일간 사용이 거의 없으면 프로젝트가 일시 정지됩니다(데이터는 유지, 대시보드에서 재개).
- 한 사람은 한 팀에만 속할 수 있습니다.
