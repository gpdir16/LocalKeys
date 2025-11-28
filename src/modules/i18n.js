const { app } = require("electron");
const path = require("path");
const fs = require("fs");

class I18n {
    constructor() {
        this.currentLocale = "en";
        this.translations = {};
        this.fallbackLocale = "en";
    }

    // 시스템 언어 감지 및 초기화
    initialize() {
        // 시스템 언어 감지
        const systemLocale = app.getLocale();

        // 언어 코드만 추출
        const languageCode = systemLocale.split("-")[0]; // ex 'ko', 'en-US', 'ja-JP'

        // 지원하는 언어인지 확인
        const supportedLocales = ["en", "ko"];

        // 테스트
        //this.currentLocale = "en";
        //this.currentLocale = "ko";
        //this.currentLocale = "ja";

        if (supportedLocales.includes(languageCode)) {
            this.currentLocale = languageCode;
        } else {
            this.currentLocale = this.fallbackLocale;
        }

        // 번역 파일 로드
        this.loadTranslations();

        return this.currentLocale;
    }

    // 번역 파일 로드
    loadTranslations() {
        const localesDir = path.join(__dirname, "..", "locales");

        // locales 디렉토리가 없으면 생성
        if (!fs.existsSync(localesDir)) {
            fs.mkdirSync(localesDir, { recursive: true });
        }

        // 현재 언어 번역 파일 로드
        const currentLocalePath = path.join(localesDir, `${this.currentLocale}.json`);
        const fallbackLocalePath = path.join(localesDir, `${this.fallbackLocale}.json`);

        try {
            if (fs.existsSync(currentLocalePath)) {
                this.translations = JSON.parse(fs.readFileSync(currentLocalePath, "utf8"));
            }
        } catch (error) {
            console.error(`Failed to load locale ${this.currentLocale}:`, error);
        }

        // fallback 로드 (현재 언어가 영어가 아닐 때)
        if (this.currentLocale !== this.fallbackLocale) {
            try {
                if (fs.existsSync(fallbackLocalePath)) {
                    this.fallbackTranslations = JSON.parse(fs.readFileSync(fallbackLocalePath, "utf8"));
                }
            } catch (error) {
                console.error(`Failed to load fallback locale:`, error);
            }
        }
    }

    // 번역 가져오기 (중첩된 키 지원)
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

        // 번역을 찾지 못하면 fallback 시도
        if (translation === undefined && this.fallbackTranslations) {
            translation = this.fallbackTranslations;
            for (const k of keys) {
                if (translation && typeof translation === "object") {
                    translation = translation[k];
                } else {
                    translation = undefined;
                    break;
                }
            }
        }

        // 여전히 못 찾으면 키 반환
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
        return this.currentLocale;
    }

    // 언어 변경 (향후 확장용)
    setLocale(locale) {
        this.currentLocale = locale;
        this.loadTranslations();
    }

    // 모든 번역 가져오기 (렌더러 프로세스용)
    getAllTranslations() {
        return {
            locale: this.currentLocale,
            translations: this.translations,
        };
    }
}

module.exports = I18n;
