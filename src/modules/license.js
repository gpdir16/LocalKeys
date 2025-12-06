const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const https = require("https");

const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAWFHz+DlwVshI6PKdIPFQ6cFN8Ow/FVnOFbesoXDVFXU=
-----END PUBLIC KEY-----`;

class License {
    constructor(userDataPath) {
        this.licenseFilePath = path.join(userDataPath, "license.json");
    }

    checkLocalLicense() {
        try {
            if (!fs.existsSync(this.licenseFilePath)) {
                return { valid: false, reason: "no_local_license" };
            }

            const licenseData = JSON.parse(fs.readFileSync(this.licenseFilePath, "utf8"));

            if (!licenseData.licence || !licenseData.signature) {
                return { valid: false, reason: "invalid_license_format" };
            }

            const isValid = this.verifySignature(licenseData.licence, licenseData.signature);

            if (!isValid) {
                return { valid: false, reason: "invalid_signature" };
            }

            if (licenseData.licence.product !== "localkeys") {
                return { valid: false, reason: "invalid_product" };
            }

            return {
                valid: true,
                licence: licenseData.licence,
            };
        } catch (error) {
            return { valid: false, reason: "error", error: error.message };
        }
    }

    verifySignature(licence, signatureBase64) {
        try {
            const message = JSON.stringify(licence);
            const signature = Buffer.from(signatureBase64, "base64");

            return crypto.verify(
                null,
                Buffer.from(message),
                {
                    key: PUBLIC_KEY,
                    format: "pem",
                    type: "spki",
                },
                signature
            );
        } catch (error) {
            return false;
        }
    }

    async checkLicenseWithServer(userKey, password) {
        return new Promise((resolve) => {
            const postData = JSON.stringify({
                userKey,
                password,
                program: "localkeys",
            });

            const options = {
                hostname: "id.privatestater.com",
                port: 443,
                path: "/api/id/license/checkkeypw",
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(postData),
                },
                timeout: 10000,
            };

            const req = https.request(options, (res) => {
                let data = "";

                res.on("data", (chunk) => {
                    data += chunk;
                });

                res.on("end", () => {
                    try {
                        const response = JSON.parse(data);

                        if (res.statusCode === 200 && response.licence && response.signature) {
                            const isValid = this.verifySignature(response.licence, response.signature);

                            if (!isValid) {
                                resolve({ success: false, error: "invalid_signature" });
                                return;
                            }

                            if (response.licence.product !== "localkeys") {
                                resolve({ success: false, error: "invalid_product" });
                                return;
                            }

                            resolve({
                                success: true,
                                licence: response.licence,
                                signature: response.signature,
                            });
                        } else if (response.error) {
                            resolve({ success: false, error: response.error });
                        } else {
                            resolve({ success: false, error: "unknown_error" });
                        }
                    } catch (error) {
                        resolve({ success: false, error: "parse_error", details: error.message });
                    }
                });
            });

            req.on("error", (error) => {
                resolve({ success: false, error: "network_error", details: error.message });
            });

            req.on("timeout", () => {
                req.destroy();
                resolve({ success: false, error: "timeout" });
            });

            req.write(postData);
            req.end();
        });
    }

    saveLicense(licence, signature) {
        try {
            const licenseData = {
                licence,
                signature,
                savedAt: new Date().toISOString(),
            };

            fs.writeFileSync(this.licenseFilePath, JSON.stringify(licenseData, null, 2), "utf8");
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    deleteLicense() {
        try {
            if (fs.existsSync(this.licenseFilePath)) {
                fs.unlinkSync(this.licenseFilePath);
            }
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }
}

module.exports = License;
