class DropdownManager {
    constructor() {
        this.initialized = false;
    }

    init() {
        if (this.initialized) return;
        this.initialized = true;

        // capture 단계에서 이벤트 처리 (stopPropagation 우회)
        document.addEventListener(
            "mousedown",
            (e) => {
                // 드롭다운 내부 클릭이 아니면 모든 드롭다운 닫기
                if (!e.target.closest(".dropdown")) {
                    this.closeAll();
                }
            },
            true,
        ); // capture: true

        // 다른 창 클릭 시 드롭다운 닫기
        window.addEventListener("blur", () => {
            this.closeAll();
        });

        // ESC 키로 드롭다운 닫기
        document.addEventListener("keydown", (e) => {
            if (e.key === "Escape") {
                this.closeAll();
            }
        });
    }

    closeAll(except = null) {
        const allDropdowns = document.querySelectorAll(".dropdown-menu:not(.hidden)");
        allDropdowns.forEach((d) => {
            // except와 그 조상은 닫지 않음
            if (except && (d === except || d.contains(except))) {
                return;
            }
            d.classList.add("hidden");
        });
    }

    toggle(dropdown) {
        if (!dropdown) return;

        const wasHidden = dropdown.classList.contains("hidden");

        // 다른 드롭다운 닫기 (현재 dropdown과 그 조상은 제외)
        this.closeAll(dropdown);

        // 현재 드롭다운 토글
        if (wasHidden) {
            dropdown.classList.remove("hidden");

            // 오른쪽 공간 부족 시 왼쪽으로 위치 조정
            dropdown.classList.remove("dropdown-menu-left");
            const rect = dropdown.getBoundingClientRect();
            if (rect.right > window.innerWidth) {
                dropdown.classList.add("dropdown-menu-left");
            }
        }
    }
}

const dropdownManager = new DropdownManager();

// DOM 로드 시 자동 초기화
if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => dropdownManager.init());
} else {
    dropdownManager.init();
}
