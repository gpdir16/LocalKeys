// 금고 로컬 vs 디스크 JSON diff / 병합 (메인 프로세스에서 사용)

function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
}

function secretPayloadForCompare(secret) {
    if (secret === undefined) return null;
    if (typeof secret === "string") {
        return { value: secret, expiresAt: null };
    }
    return {
        value: secret.value,
        expiresAt: secret.expiresAt ?? null,
    };
}

function secretsEqual(a, b) {
    const pa = secretPayloadForCompare(a);
    const pb = secretPayloadForCompare(b);
    if (!pa || !pb) return pa === pb;
    return pa.value === pb.value && pa.expiresAt === pb.expiresAt;
}

function previewSecretValue(secret) {
    const raw = typeof secret === "string" ? secret : (secret?.value ?? "");
    const s = String(raw);
    if (s.length === 0) return "—";
    const len = ` (${s.length} chars)`;
    if (s.length <= 4) return `••••${len}`;
    return `••••${s.slice(-2)}${len}`;
}

function conflictKey(project, secretKey) {
    return `${project}::${secretKey}`;
}

// localData: 정규화된 로컬 금고 데이터, remoteData: 정규화된 디스크 금고 데이터
function buildVaultDiff(localData, remoteData) {
    const lp = localData?.projects && typeof localData.projects === "object" ? localData.projects : {};
    const rp = remoteData?.projects && typeof remoteData.projects === "object" ? remoteData.projects : {};

    const rows = [];
    const projectNames = new Set([...Object.keys(lp), ...Object.keys(rp)]);

    for (const project of projectNames) {
        if (!rp[project]) {
            rows.push({
                kind: "project",
                status: "only_local",
                project,
                id: `project::${project}`,
            });
            continue;
        }
        if (!lp[project]) {
            rows.push({
                kind: "project",
                status: "only_remote",
                project,
                id: `project::${project}`,
            });
            continue;
        }

        const ls = lp[project].secrets && typeof lp[project].secrets === "object" ? lp[project].secrets : {};
        const rs = rp[project].secrets && typeof rp[project].secrets === "object" ? rp[project].secrets : {};
        const keys = new Set([...Object.keys(ls), ...Object.keys(rs)]);

        for (const key of keys) {
            if (rs[key] === undefined) {
                rows.push({
                    kind: "secret",
                    status: "only_local",
                    project,
                    key,
                    id: conflictKey(project, key),
                });
            } else if (ls[key] === undefined) {
                rows.push({
                    kind: "secret",
                    status: "only_remote",
                    project,
                    key,
                    id: conflictKey(project, key),
                });
            } else if (!secretsEqual(ls[key], rs[key])) {
                rows.push({
                    kind: "secret",
                    status: "conflict",
                    project,
                    key,
                    id: conflictKey(project, key),
                    localPreview: previewSecretValue(ls[key]),
                    remotePreview: previewSecretValue(rs[key]),
                });
            }
        }
    }

    const conflictCount = rows.filter((r) => r.status === "conflict").length;
    const onlyLocal = rows.filter((r) => r.status === "only_local").length;
    const onlyRemote = rows.filter((r) => r.status === "only_remote").length;

    return {
        rows,
        summary: {
            conflictCount,
            onlyLocal,
            onlyRemote,
            isEmpty: rows.length === 0,
        },
    };
}

function mergeFavoritesUnion(localFav, remoteFav, mergedProjects) {
    const names = new Set(Object.keys(mergedProjects));
    const projSet = new Set();
    const addProj = (arr) => {
        if (!Array.isArray(arr)) return;
        for (const x of arr) {
            if (typeof x === "string" && names.has(x)) projSet.add(x);
        }
    };
    addProj(localFav?.projects);
    addProj(remoteFav?.projects);

    const secrets = Object.create(null);
    for (const p of names) {
        const keys = new Set();
        const ls = localFav?.secrets?.[p];
        const rs = remoteFav?.secrets?.[p];
        const mergedSec = mergedProjects[p]?.secrets || {};
        if (Array.isArray(ls)) {
            for (const k of ls) {
                if (typeof k === "string" && mergedSec[k] !== undefined) keys.add(k);
            }
        }
        if (Array.isArray(rs)) {
            for (const k of rs) {
                if (typeof k === "string" && mergedSec[k] !== undefined) keys.add(k);
            }
        }
        if (keys.size > 0) {
            secrets[p] = [...keys];
        }
    }

    return {
        projects: [...projSet],
        secrets,
    };
}

function snapshotSecretForBaseline(secret) {
    const p = secretPayloadForCompare(secret);
    return p ? JSON.parse(JSON.stringify(p)) : null;
}

function projectSecretsMatchBaseline(localProj, baselineProj) {
    const ls = localProj?.secrets && typeof localProj.secrets === "object" ? localProj.secrets : {};
    const bs = baselineProj?.secrets && typeof baselineProj.secrets === "object" ? baselineProj.secrets : {};
    const bKeys = Object.keys(bs);
    const lKeys = Object.keys(ls);
    if (bKeys.length !== lKeys.length) return false;
    for (const k of bKeys) {
        if (!Object.prototype.hasOwnProperty.call(ls, k)) return false;
        if (!secretsEqual(ls[k], bs[k])) return false;
    }
    return true;
}

// baseline 대비 3-way 병합. 한쪽만 바뀐 항목은 그쪽 값, baseline에서 갈라져 동시 수정된 경우만 충돌.
// baselineData: { projects, favorites }(favorites는 normalizeFavoritesForCompare 결과). 반환: { merged, conflicts }.
function mergeVaultThreeWay(localData, remoteData, baselineData) {
    const bp = baselineData?.projects && typeof baselineData.projects === "object" ? baselineData.projects : {};
    const lp = localData?.projects && typeof localData.projects === "object" ? localData.projects : {};
    const rp = remoteData?.projects && typeof remoteData.projects === "object" ? remoteData.projects : {};

    const conflicts = [];
    const allProj = new Set([...Object.keys(lp), ...Object.keys(rp)]);

    function pushConflict(c) {
        conflicts.push(c);
    }

    // 1) 충돌만 수집
    for (const pname of allProj) {
        const hasL = lp[pname] != null;
        const hasR = rp[pname] != null;
        const baseP = bp[pname];

        if (!hasR) {
            if (!hasL) continue;
            if (baseP) {
                if (!projectSecretsMatchBaseline(lp[pname], baseP)) {
                    pushConflict({ kind: "project", project: pname, reason: "remote_deleted_project_local_changed" });
                }
            }
            continue;
        }

        if (!hasL) {
            continue;
        }

        const ls = lp[pname].secrets && typeof lp[pname].secrets === "object" ? lp[pname].secrets : {};
        const rs = rp[pname].secrets && typeof rp[pname].secrets === "object" ? rp[pname].secrets : {};
        const bs = baseP?.secrets && typeof baseP.secrets === "object" ? baseP.secrets : {};
        const keys = new Set([...Object.keys(ls), ...Object.keys(rs)]);

        for (const k of keys) {
            const l = ls[k];
            const r = rs[k];
            const b = bs[k];

            if (l !== undefined && r !== undefined) {
                if (secretsEqual(l, r)) continue;
                if (b === undefined) {
                    pushConflict({ kind: "secret", project: pname, key: k, reason: "simultaneous_add_divergent" });
                    continue;
                }
                if (secretsEqual(l, b) && !secretsEqual(r, b)) continue;
                if (secretsEqual(r, b) && !secretsEqual(l, b)) continue;
                if (secretsEqual(l, b) && secretsEqual(r, b)) continue;
                if (!secretsEqual(l, b) && !secretsEqual(r, b)) {
                    if (secretsEqual(l, r)) continue;
                    pushConflict({ kind: "secret", project: pname, key: k, reason: "divergent_edit" });
                }
                continue;
            }

            if (l !== undefined && r === undefined) {
                if (b === undefined) continue;
                if (!secretsEqual(l, b)) {
                    pushConflict({ kind: "secret", project: pname, key: k, reason: "remote_deleted_local_edited" });
                }
                continue;
            }

            if (l === undefined && r !== undefined) {
                if (b === undefined) continue;
                if (!secretsEqual(r, b)) {
                    pushConflict({ kind: "secret", project: pname, key: k, reason: "local_deleted_remote_edited" });
                }
            }
        }
    }

    const bf = baselineData?.favorites;
    if (detectFavoritesThreeWayConflict(localData.favorites, remoteData.favorites, bf)) {
        pushConflict({ kind: "favorites", reason: "favorites_divergent" });
    }

    if (conflicts.length > 0) {
        return { merged: null, conflicts };
    }

    // 2) 병합 생성
    const merged = deepClone(localData);
    const out = Object.create(null);

    for (const pname of allProj) {
        const hasL = lp[pname] != null;
        const hasR = rp[pname] != null;
        const baseP = bp[pname];

        if (!hasR) {
            if (!hasL) continue;
            if (baseP) {
                continue;
            }
            out[pname] = deepClone(lp[pname]);
            continue;
        }

        if (!hasL) {
            out[pname] = deepClone(rp[pname]);
            continue;
        }

        const ls = lp[pname].secrets && typeof lp[pname].secrets === "object" ? lp[pname].secrets : {};
        const rs = rp[pname].secrets && typeof rp[pname].secrets === "object" ? rp[pname].secrets : {};
        const bs = baseP?.secrets && typeof baseP.secrets === "object" ? baseP.secrets : {};
        const keys = new Set([...Object.keys(ls), ...Object.keys(rs)]);
        const mergedSecrets = Object.create(null);

        for (const k of keys) {
            const l = ls[k];
            const r = rs[k];
            const b = bs[k];

            if (l !== undefined && r !== undefined) {
                if (secretsEqual(l, r)) {
                    mergedSecrets[k] = deepClone(l);
                } else if (b === undefined) {
                    mergedSecrets[k] = deepClone(l);
                } else if (secretsEqual(l, b) && !secretsEqual(r, b)) {
                    mergedSecrets[k] = deepClone(r);
                } else if (secretsEqual(r, b) && !secretsEqual(l, b)) {
                    mergedSecrets[k] = deepClone(l);
                } else if (secretsEqual(l, b) && secretsEqual(r, b)) {
                    mergedSecrets[k] = deepClone(l);
                } else if (!secretsEqual(l, b) && !secretsEqual(r, b) && secretsEqual(l, r)) {
                    mergedSecrets[k] = deepClone(l);
                } else {
                    mergedSecrets[k] = deepClone(l);
                }
                continue;
            }

            if (l !== undefined && r === undefined) {
                if (b === undefined) {
                    mergedSecrets[k] = deepClone(l);
                }
                continue;
            }

            if (l === undefined && r !== undefined) {
                if (b === undefined) {
                    mergedSecrets[k] = deepClone(r);
                }
            }
        }

        out[pname] = {
            ...deepClone(lp[pname]),
            secrets: mergedSecrets,
        };
    }

    merged.projects = out;
    const mergedFav = mergeFavoritesThreeWayMerge(localData.favorites, remoteData.favorites, bf);
    merged.favorites = mergeFavoritesUnion(mergedFav, mergedFav, out);
    merged.updatedAt = new Date().toISOString();
    return { merged, conflicts: [] };
}

function detectFavoritesThreeWayConflict(localFav, remoteFav, baselineFav) {
    const b = baselineFav !== undefined ? baselineFav : normalizeFavoritesForCompare({});
    if (favoritesEqual(localFav, remoteFav)) return false;
    if (favoritesEqual(localFav, b) && !favoritesEqual(remoteFav, b)) return false;
    if (favoritesEqual(remoteFav, b) && !favoritesEqual(localFav, b)) return false;
    if (favoritesEqual(localFav, b) && favoritesEqual(remoteFav, b)) return false;
    if (!favoritesEqual(localFav, b) && !favoritesEqual(remoteFav, b)) {
        if (favoritesEqual(localFav, remoteFav)) return false;
        return true;
    }
    return false;
}

function mergeFavoritesThreeWayMerge(localFav, remoteFav, baselineFav) {
    const b = baselineFav !== undefined ? baselineFav : normalizeFavoritesForCompare({});
    if (favoritesEqual(localFav, remoteFav)) return deepClone(localFav);
    if (favoritesEqual(localFav, b) && !favoritesEqual(remoteFav, b)) return deepClone(remoteFav);
    if (favoritesEqual(remoteFav, b) && !favoritesEqual(localFav, b)) return deepClone(localFav);
    if (favoritesEqual(localFav, b) && favoritesEqual(remoteFav, b)) return deepClone(localFav);
    if (!favoritesEqual(localFav, b) && !favoritesEqual(remoteFav, b) && favoritesEqual(localFav, remoteFav)) {
        return deepClone(localFav);
    }
    return deepClone(localFav);
}

// conflictChoices: 키 "project::secretKey", 값 'local' | 'remote'
function mergeVaultData(localData, remoteData, conflictChoices) {
    const merged = deepClone(localData);
    const lp = merged.projects || Object.create(null);
    merged.projects = lp;
    const rp = remoteData?.projects && typeof remoteData.projects === "object" ? remoteData.projects : {};

    for (const [pname, rproj] of Object.entries(rp)) {
        if (!rproj || typeof rproj !== "object") continue;

        if (!lp[pname]) {
            lp[pname] = deepClone(rproj);
            continue;
        }

        const ls = lp[pname].secrets || Object.create(null);
        lp[pname].secrets = ls;
        const rs = rproj.secrets && typeof rproj.secrets === "object" ? rproj.secrets : {};

        for (const [key, rval] of Object.entries(rs)) {
            if (ls[key] === undefined) {
                ls[key] = deepClone(rval);
            } else if (!secretsEqual(ls[key], rval)) {
                const ck = conflictKey(pname, key);
                const side = conflictChoices[ck] || "local";
                if (side === "remote") {
                    ls[key] = deepClone(rval);
                }
            }
        }
    }

    merged.favorites = mergeFavoritesUnion(localData.favorites, remoteData.favorites, lp);
    merged.updatedAt = new Date().toISOString();
    return merged;
}

function normalizeFavoritesForCompare(fav) {
    if (!fav || typeof fav !== "object") {
        return { projects: [], secrets: {} };
    }
    const projects = Array.isArray(fav.projects) ? [...fav.projects].filter((x) => typeof x === "string").sort() : [];
    const secrets = Object.create(null);
    for (const [pn, keys] of Object.entries(fav.secrets || {})) {
        if (Array.isArray(keys)) {
            secrets[pn] = [...keys].filter((k) => typeof k === "string").sort();
        }
    }
    const sortedProjectNames = Object.keys(secrets).sort();
    const secretsOut = Object.create(null);
    for (const k of sortedProjectNames) {
        secretsOut[k] = secrets[k];
    }
    return { projects, secrets: secretsOut };
}

function favoritesEqual(a, b) {
    return JSON.stringify(normalizeFavoritesForCompare(a)) === JSON.stringify(normalizeFavoritesForCompare(b));
}

// 프로젝트/시크릿 diff 행이 없고 즐겨찾기도 같으면, 암호문만 다른(metadata) 충돌로 보고 UI 없이 재동기화 가능
function isSilentResolvable(localData, remoteData) {
    const d = buildVaultDiff(localData, remoteData);
    if (d.rows.length > 0) return false;
    return favoritesEqual(localData.favorites, remoteData.favorites);
}

module.exports = {
    buildVaultDiff,
    mergeVaultData,
    mergeVaultThreeWay,
    snapshotSecretForBaseline,
    secretPayloadForCompare,
    secretsEqual,
    normalizeFavoritesForCompare,
    isSilentResolvable,
};
