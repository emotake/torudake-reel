export type PublicSocialLink = {
  id: "instagram" | "youtube";
  label: string;
  href: string;
};

function normalizeSocialUrl(
  value: string | undefined,
  hostname: string,
) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    if (url.hostname !== hostname && !url.hostname.endsWith(`.${hostname}`)) {
      return null;
    }
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function getPublicSocialLinks(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): PublicSocialLink[] {
  const instagram = normalizeSocialUrl(
    environment.NEXT_PUBLIC_INSTAGRAM_URL,
    "instagram.com",
  );
  const youtube = normalizeSocialUrl(
    environment.NEXT_PUBLIC_YOUTUBE_URL,
    "youtube.com",
  );

  return [
    ...(instagram
      ? [{ id: "instagram" as const, label: "Instagram", href: instagram }]
      : []),
    ...(youtube
      ? [{ id: "youtube" as const, label: "YouTube", href: youtube }]
      : []),
  ];
}
