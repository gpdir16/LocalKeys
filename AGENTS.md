# LocalKeys-App - AI Agent 작업 규칙

## CSS 구조 규칙

### common.css (src/styles/common.css)
모든 페이지에서 공통으로 사용되거나, 어디서든 쓰일 수 있는 범용 스타일만 포함한다.

**공통에 포함해야 하는 것:**
- 리셋 및 기본 설정 (`*`, `html`, `body`)
- CSS 변수 (`:root`)
- 타이포그래피, 스크롤바, 이미지 드래그 방지
- 아이콘 시스템 (`.lk-icon`, `.lk-icon-*`)
- 버튼 시스템 (`.btn`, `.btn-primary`, `.btn-secondary`, `.btn-danger`, `.btn-success`)
- 레이아웃 유틸리티 (`.container`, `.flex`, `.flex-*`, `.gap-*`, `.mt-*`, `.mb-*`)
- 입력 필드 (`.input-group`, `.input-inline`, `.input-row`, `.input-desc`)
- 카드, 리스트, 폼 (`.card`, `.list`, `.form`)
- 모달 시스템 (`.modal`, `.modal-overlay`, `.modal-sm`, `.modal-footer-column`, `.modal-error`)
- 알림 메시지 (`.message`, `.message-*`)
- 로딩/스피너 (`.spinner`)
- 검색바 (`.search-bar`, `.search-input`)
- 드롭다운 (`.dropdown`, `.dropdown-menu`, `.dropdown-item`)
- 빈 상태 (`.empty-state`, `.empty-state-*`)
- 페이지 헤더 (`.page-header`, `.page-title`, `.page-title-group`, `.header-actions`)
- 필터 선택 (`.filter-select`)
- 윈도우 포커스 상태 스타일
- 뒤로 가기 버튼 (`.back-btn`) — 여러 페이지 공용

**판단 기준:** 지금 한 페이지에서만 쓰이더라도, 다른 페이지에서도 자연스럽게 쓰일 수 있는 범용 패턴이면 common.css에 포함한다.

---

### 페이지별 CSS (src/styles/<page>.css)
특정 페이지나 특정 기능에만 속하는 컴포넌트 스타일.

**페이지별 파일에 포함해야 하는 것:**
- 특정 기능 전용 UI 컴포넌트 (예: vault-selector, vault-dropdown, vault-item 등은 dashboard 전용)
- 해당 페이지의 레이아웃 구조 (사이드바, 콘텐츠 영역 등)
- 다른 페이지에서 재사용될 가능성이 없는 스타일

**현재 페이지별 파일:**
- `dashboard.css` — vault 선택기 및 금고 관련 UI 전용

---

### HTML에서 CSS 로드 순서
```html
<link rel="stylesheet" href="../styles/common.css" />
<link rel="stylesheet" href="../styles/<page>.css" />  <!-- 해당 페이지 전용 파일이 있을 때만 -->
```
페이지별 CSS가 common.css를 override할 수 있도록 항상 common.css를 먼저 로드한다.
