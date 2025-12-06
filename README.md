# 설치

## 앱 실행

```bash
# GUI 앱 실행
npm start
```

# CLI 사용

```bash
# 프로젝트 목록 확인
localkeys list

# 시크릿 저장
localkeys set myapp API_KEY "sk-1234567890abcdef"

# 시크릿 조회
localkeys get myapp API_KEY

# 환경변수와 함께 명령 실행
localkeys run --project=myapp -- npm start
```

# 빌드

```bash
# 애플리케이션 빌드
npm run build

# 플랫폼별 빌드
npm run build -- --mac
npm run build -- --win
npm run build -- --linux
```
