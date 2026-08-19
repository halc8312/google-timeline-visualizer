const SUBDOMAINS = ["a", "b", "c", "d"];

export class TileCache {
  constructor({ maxEntries = 640 } = {}) {
    this.maxEntries = maxEntries;
    this.cache = new Map();
    this.pending = new Map();
  }

  get(url) {
    const value = this.cache.get(url);
    if (!value) return null;
    this.cache.delete(url);
    this.cache.set(url, value);
    return value;
  }

  async load(url, signal) {
    const cached = this.get(url);
    if (cached) return cached;
    if (this.pending.has(url)) return this.pending.get(url);

    const promise = this.#loadImage(url, signal)
      .then((image) => {
        if (image) {
          this.cache.set(url, image);
          this.#trim();
        }
        return image;
      })
      .catch(() => null)
      .finally(() => this.pending.delete(url));
    this.pending.set(url, promise);
    return promise;
  }

  async loadMany(urls, { concurrency = 6, onProgress = () => {}, signal } = {}) {
    const unique = [...new Set(urls)];
    let cursor = 0;
    let completed = 0;
    const worker = async () => {
      while (cursor < unique.length) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const index = cursor;
        cursor += 1;
        await this.load(unique[index], signal);
        completed += 1;
        onProgress(completed, unique.length);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(concurrency, unique.length) }, () => worker()),
    );
  }

  clear() {
    for (const image of this.cache.values()) image?.close?.();
    this.cache.clear();
    this.pending.clear();
  }

  async #loadImage(url, signal) {
    const response = await fetch(url, {
      mode: "cors",
      cache: "force-cache",
      credentials: "omit",
      signal,
    });
    if (!response.ok) throw new Error(`Map tile ${response.status}`);
    const blob = await response.blob();
    if (typeof createImageBitmap === "function") {
      return createImageBitmap(blob);
    }
    return new Promise((resolve, reject) => {
      const objectUrl = URL.createObjectURL(blob);
      const image = new Image();
      image.onload = () => {
        URL.revokeObjectURL(objectUrl);
        resolve(image);
      };
      image.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        reject(new Error("Map tile could not be decoded"));
      };
      image.src = objectUrl;
    });
  }

  #trim() {
    while (this.cache.size > this.maxEntries) {
      const [oldestUrl, oldestImage] = this.cache.entries().next().value;
      this.cache.delete(oldestUrl);
      oldestImage?.close?.();
    }
  }
}

export function cartoTileUrl(zoom, x, y) {
  const dimension = 2 ** zoom;
  const wrappedX = positiveModulo(x, dimension);
  if (y < 0 || y >= dimension) return null;
  const subdomain = SUBDOMAINS[positiveModulo(wrappedX + y, SUBDOMAINS.length)];
  return `https://${subdomain}.basemaps.cartocdn.com/light_all/${zoom}/${wrappedX}/${y}@2x.png`;
}

export function positiveModulo(value, modulus) {
  return ((value % modulus) + modulus) % modulus;
}
