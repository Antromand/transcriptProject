const VK_COM_HOST = "vk.com";
const VKVIDEO_HOST = "vkvideo.ru";

function isHostOrSubdomain(host, root) {
  return host === root || host.endsWith(`.${root}`);
}

export function isValidVkMask(rawUrl) {
  try {
    const url = new URL(rawUrl.trim());
    const host = url.hostname.toLowerCase();

    if (isHostOrSubdomain(host, VK_COM_HOST)) {
      // https://vk.com/{sometext}?z=video-{somenumber}
      if (!url.pathname || url.pathname === "/") return false;
      if (!url.searchParams.has("z")) return false;
      const z = url.searchParams.get("z") || "";
      return /^video-\d+(_\d+)?$/.test(z);
    }

    if (isHostOrSubdomain(host, VKVIDEO_HOST)) {
      // https://vkvideo.ru/video-{somenumber}
      return /^\/video-\d+(_\d+)?$/.test(url.pathname || "");
    }

    return false;
  } catch {
    return false;
  }
}

