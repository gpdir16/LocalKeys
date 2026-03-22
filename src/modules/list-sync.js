function syncListByKey(parent, items, options) {
    const keyAttr = options.keyAttr || "data-list-key";
    const { getKey, create, update } = options;

    const desiredKeys = items.map((item) => getKey(item));
    const keySet = new Set(desiredKeys);

    const existing = new Map();
    for (const child of Array.from(parent.children)) {
        const k = child.getAttribute(keyAttr);
        if (k) {
            existing.set(k, child);
        }
    }

    const staleKeys = [];
    for (const [k] of existing) {
        if (!keySet.has(k)) {
            staleKeys.push(k);
        }
    }
    for (const k of staleKeys) {
        const el = existing.get(k);
        el.remove();
        existing.delete(k);
    }

    let insertBefore = null;
    for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i];
        const key = getKey(item);
        let el = existing.get(key);
        if (!el) {
            el = create(item);
            if (!el.getAttribute(keyAttr)) {
                el.setAttribute(keyAttr, key);
            }
            existing.set(key, el);
        } else {
            update(el, item);
        }
        if (el.parentNode !== parent || el.nextSibling !== insertBefore) {
            parent.insertBefore(el, insertBefore);
        }
        insertBefore = el;
    }
}
