# LocalKeys-App - AI Agent 작업 규칙

## CSS 구조 규칙

### common.css (src/styles/common.css)
모든 페이지에서 공통으로 사용되거나, 어디서든 쓰일 수 있는 범용 스타일만 포함한다.

**판단 기준:** 지금 한 페이지에서만 쓰이더라도, 다른 페이지에서도 자연스럽게 쓰일 수 있는 범용 패턴이면 common.css에 포함한다.

### 페이지별 CSS (src/styles/<page>.css)
특정 페이지나 특정 기능에만 속하는 컴포넌트 스타일.

**페이지별 파일에 포함해야 하는 것:**
- 특정 기능 전용 UI 컴포넌트 (예: vault-selector, vault-dropdown, vault-item 등은 dashboard 전용)
- 해당 페이지의 레이아웃 구조 (사이드바, 콘텐츠 영역 등)
- 다른 페이지에서 재사용될 가능성이 없는 스타일

---

### HTML에서 CSS 로드 순서
```html
<link rel="stylesheet" href="../styles/common.css" />
<link rel="stylesheet" href="../styles/<page>.css" />  <!-- 해당 페이지 전용 파일이 있을 때만 -->
```
페이지별 CSS가 common.css를 override할 수 있도록 항상 common.css를 먼저 로드한다.
