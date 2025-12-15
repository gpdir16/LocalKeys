# LocalKeys

[English](README.md) | **한국어**

LocalKeys는 로컬에서 시크릿(환경 변수)을 암호화해 저장하고, GUI로 관리하면서 CLI에서 승인 기반으로 안전하게 가져올 수 있는 Electron 데스크톱 앱입니다.

**LocalKeys는 오픈소스이지만, 사용을 위해 유료 라이선스가 필요합니다.**
$7.99(원화 결재시 9,900원)에 평생 업데이트가 포함된 평생 라이선스를 구매할 수 있습니다.
자세한 내용은 제품 페이지를 참고하세요.

- 제품 페이지: https://localkeys.privatestater.com

## 주요 기능

- 로컬 우선 암호화 Vault (AES-256-GCM)
- 완전 오프라인 동작
- 프로세스 승인(approval) 기반 접근 제어
- GUI 및 CLI 인터페이스 제공
- 기존 개발 워크플로우와 자연스러운 통합
- macOS 및 Windows 지원
- 1회 구매, 평생 업데이트

## CLI 사용법

CLI를 사용하려면 앱이 실행 중이어야 하며 금고가 잠금 해제된 상태여야 합니다. 요청 시 앱에서 승인 팝업이 표시됩니다.

```bash
# 프로젝트 목록
localkeys list

# 시크릿 저장 (쓰기 승인 필요)
localkeys set myapp API_KEY "sk-1234567890abcdef"

# 시크릿 조회 (읽기 승인 필요) - 출력: `{ value, expiresAt }`
localkeys get myapp API_KEY

# 프로젝트의 모든 시크릿을 환경변수로 주입해 명령 실행 (읽기 승인 필요)
localkeys run --project=myapp -- npm start
```

## 네트워크 연결

설정/기능에 따라 앱에서 아래 인터넷 연결이 발생할 수 있습니다.

- 업데이트 체크: `https://localkeys.privatestater.com/api/version`
- 라이선스 확인/활성화: `https://id.privatestater.com/api/id/license/*`

설정에서 자동 업데이트 체크를 끌 수 있으며, 초기 설정 이후에는 라이선스 검증이 다시 호출되지 않습니다.
첫 설정을 완료한 뒤에는 방화벽으로 모든 인터넷 연결을 차단해도 됩니다.

## 빌드

```bash
npm run build -- --mac && npm run build -- --win
```

### 플랫폼별 빌드

```bash
npm run build -- --mac
npm run build -- --win
npm run build -- --linux # 빌드와 사용은 가능하지만 아직 정식으로 지원하지 않습니다
```