import type { Metadata } from "next";
import {
  SITE_NAME,
  SITE_OG_IMAGE_PATH,
  SITE_ORIGIN,
} from "./site";

export function buildPublicPageMetadata({
  title,
  description,
  path,
}: {
  title: string;
  description: string;
  path: string;
}): Metadata {
  return {
    title,
    description,
    alternates: {
      canonical: path,
    },
    openGraph: {
      title,
      description,
      url: path,
      siteName: SITE_NAME,
      type: "website",
      locale: "ja_JP",
      images: [
        {
          url: SITE_OG_IMAGE_PATH,
          width: 1734,
          height: 907,
          alt: `${SITE_NAME}｜動画を選ぶだけで自動編集`,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [SITE_OG_IMAGE_PATH],
    },
  };
}

export const siteMetadataBase = new URL(SITE_ORIGIN);
