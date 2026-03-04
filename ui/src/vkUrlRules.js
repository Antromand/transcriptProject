const VK_COM_HOST = "vk.com";
const VKVIDEO_HOST = "vkvideo.ru";
const YOUTUBE_HOST = "youtube.com";
const YOUTU_BE_HOST = "youtu.be";
const TWITCH_HOST = "twitch.tv";
const TWITCH_CLIPS_HOST = "clips.twitch.tv";

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

function isValidYoutubeUrl(url) {
  const host = url.hostname.toLowerCase();
  if (isHostOrSubdomain(host, YOUTU_BE_HOST)) {
    const videoId = (url.pathname || "").split("/").filter(Boolean)[0] || "";
    return /^[A-Za-z0-9_-]{6,}$/.test(videoId);
  }

  if (!isHostOrSubdomain(host, YOUTUBE_HOST)) return false;

  const path = (url.pathname || "").toLowerCase();
  if (path === "/watch") {
    const v = (url.searchParams.get("v") || "").trim();
    return /^[A-Za-z0-9_-]{6,}$/.test(v);
  }

  const parts = (url.pathname || "").split("/").filter(Boolean);
  if (parts.length >= 2 && (parts[0] === "shorts" || parts[0] === "live" || parts[0] === "embed")) {
    return /^[A-Za-z0-9_-]{6,}$/.test(parts[1] || "");
  }

  return false;
}

function isValidTwitchUrl(url) {
  const host = url.hostname.toLowerCase();
  const path = url.pathname || "";

  if (isHostOrSubdomain(host, TWITCH_CLIPS_HOST)) {
    const clipSlug = path.split("/").filter(Boolean)[0] || "";
    return /^[A-Za-z0-9_-]{6,}$/.test(clipSlug);
  }

  if (!isHostOrSubdomain(host, TWITCH_HOST)) return false;

  const parts = path.split("/").filter(Boolean);
  if (parts.length >= 2 && parts[0].toLowerCase() === "videos") {
    return /^\d+$/.test(parts[1] || "");
  }
  if (parts.length >= 3 && parts[1].toLowerCase() === "clip") {
    return /^[A-Za-z0-9_-]{6,}$/.test(parts[2] || "");
  }

  return false;
}

export function isSupportedVideoUrl(rawUrl) {
  try {
    const url = new URL(rawUrl.trim());
    return isValidVkMask(rawUrl) || isValidYoutubeUrl(url) || isValidTwitchUrl(url);
  } catch {
    return false;
  }
}
