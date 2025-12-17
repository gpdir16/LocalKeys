// 렌더러 프로세스용 i18n 헬퍼
// <script src="../modules/i18n-helper.js"></script>

class I18nHelper {
    constructor() {
        this.translations = {};
        this.locale = "en";
        this._isBoundToLocaleChanges = false;
    }

    // 번역 초기화
    async init() {
        try {
            const data = await window.localkeys.i18n.getTranslations();
            this.translations = data.translations || {};
            this.locale = data.locale || "en";
            try {
                if (document?.documentElement) {
                    document.documentElement.lang = this.locale;
                }
            } catch {}

            this._bindToLocaleChanges();
            return true;
        } catch (error) {
            console.error("Failed to load translations:", error);
            return false;
        }
    }

    _bindToLocaleChanges() {
        if (this._isBoundToLocaleChanges) return;
        if (!window?.localkeys?.i18n?.onLocaleChanged) return;

        this._isBoundToLocaleChanges = true;
        window.localkeys.i18n.onLocaleChanged((data) => {
            if (!data || typeof data !== "object") {
                window.location.reload();
                return;
            }

            this.translations = data.translations || {};
            this.locale = data.locale || this.locale;
            try {
                if (document?.documentElement) {
                    document.documentElement.lang = this.locale;
                }
            } catch {}

            window.location.reload();
        });
    }

    // 번역 가져오기
    t(key, replacements = {}) {
        const keys = key.split(".");
        let translation = this.translations;

        // 중첩된 객체에서 값 찾기
        for (const k of keys) {
            if (translation && typeof translation === "object") {
                translation = translation[k];
            } else {
                translation = undefined;
                break;
            }
        }

        // 번역을 찾지 못하면 키 반환
        if (translation === undefined) {
            return key;
        }

        // 문자열이 아니면 키 반환
        if (typeof translation !== "string") {
            return key;
        }

        // 플레이스홀더 치환 ({{key}} 형식)
        let result = translation;
        for (const [placeholder, value] of Object.entries(replacements)) {
            result = result.replace(new RegExp(`{{${placeholder}}}`, "g"), value);
        }

        return result;
    }

    // 현재 언어 가져오기
    getLocale() {
        return this.locale;
    }
}

// 전역 i18n 인스턴스 생성
const i18n = new I18nHelper();
