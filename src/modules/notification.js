// 알림 시스템 모듈
class NotificationManager {
    constructor() {
        this.currentNotification = null;
        this.autoCloseTimeout = null;
    }

    // 메시지 표시
    show(message, type = "info") {
        // 기존 알림이 있으면 제거
        if (this.currentNotification) {
            this.hide();
        }

        // 로컬스토리지에 알림 저장
        this.saveToStorage(message, type);

        const messageEl = document.createElement("div");
        messageEl.className = `message message-${type}`;

        // 아이콘 결정
        let icon = "✓";
        if (type === "error") icon = "✕";
        else if (type === "warning") icon = "⚠";

        messageEl.innerHTML = `
            <div class="message-content">
                <div class="message-header">
                    <div class="message-left">
                        <div class="message-icon">${icon}</div>
                        <div class="message-text">${this.escapeHtml(message)}</div>
                    </div>
                </div>
                <button class="message-close">×</button>
            </div>
        `;

        document.body.appendChild(messageEl);
        this.currentNotification = messageEl;

        // 애니메이션을 위해 약간의 딜레이 후 show 클래스 추가
        setTimeout(() => {
            messageEl.classList.add("show");
        }, 10);

        // 닫기 버튼 이벤트
        const closeBtn = messageEl.querySelector(".message-close");
        closeBtn.addEventListener("click", () => {
            this.hide();
        });

        // 10초 후 자동 닫기
        this.autoCloseTimeout = setTimeout(() => {
            this.hide();
        }, 10000);
    }

    // 메시지 숨기기
    hide() {
        if (!this.currentNotification) return;

        const messageEl = this.currentNotification;

        // 자동 닫기 타임아웃 제거
        if (this.autoCloseTimeout) {
            clearTimeout(this.autoCloseTimeout);
            this.autoCloseTimeout = null;
        }

        messageEl.classList.add("hide");
        // 로컬스토리지에서 제거
        localStorage.removeItem("localkeys_notifications");

        // 애니메이션이 끝난 후 DOM에서 제거
        setTimeout(() => {
            if (document.body.contains(messageEl)) {
                document.body.removeChild(messageEl);
            }
            this.currentNotification = null;
        }, 300);
    }

    // 성공 메시지
    success(message) {
        this.show(message, "success");
    }

    // 에러 메시지
    error(message) {
        this.show(message, "error");
    }

    // 경고 메시지
    warning(message) {
        this.show(message, "warning");
    }

    // 유틸리티 함수
    escapeHtml(text) {
        const div = document.createElement("div");
        div.textContent = text;
        return div.innerHTML;
    }

    // 로컬스토리지에 저장
    saveToStorage(message, type) {
        try {
            localStorage.setItem(
                "localkeys_notifications",
                JSON.stringify({
                    message,
                    type,
                    timestamp: Date.now(),
                })
            );
        } catch (error) {
            console.error("Failed to save notification:", error);
        }
    }

    // 저장된 알림 불러오기
    loadStored() {
        const stored = localStorage.getItem("localkeys_notifications");
        if (stored) {
            try {
                const notification = JSON.parse(stored);
                if (notification && notification.message) {
                    this.showStatic(notification.message, notification.type);
                }
            } catch (error) {
                console.error("Failed to load stored notifications:", error);
                localStorage.removeItem("localkeys_notifications");
            }
        }
    }

    // 애니메이션 없이 알림 표시 (저장된 알림용)
    showStatic(message, type) {
        // 기존 알림이 있으면 제거
        if (this.currentNotification) {
            this.hide();
        }

        const messageEl = document.createElement("div");
        messageEl.className = `message message-${type}`;

        // 아이콘 결정
        let icon = "✓";
        if (type === "error") icon = "✕";
        else if (type === "warning") icon = "⚠";

        messageEl.innerHTML = `
            <div class="message-content">
                <div class="message-header">
                    <div class="message-left">
                        <div class="message-icon">${icon}</div>
                        <div class="message-text">${this.escapeHtml(message)}</div>
                    </div>
                </div>
                <button class="message-close">×</button>
            </div>
        `;

        document.body.appendChild(messageEl);
        this.currentNotification = messageEl;

        // 애니메이션 없이 바로 표시
        messageEl.classList.add("show");

        // 닫기 버튼 이벤트
        const closeBtn = messageEl.querySelector(".message-close");
        closeBtn.addEventListener("click", () => {
            this.hide();
        });

        // 10초 후 자동 닫기
        this.autoCloseTimeout = setTimeout(() => {
            this.hide();
        }, 10000);
    }
}

// 글로벌 인스턴스 생성
const notificationManager = new NotificationManager();
