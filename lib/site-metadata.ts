import type { Metadata } from "next";
import {
  SITE_NAME,
  SITE_OG_IMAGE_PATH,
  SITE_ORIGIN,
} from "./site";

export type PublicPageImage = {
  path: string;
  width: number;
  height: number;
  alt: string;
};

export function buildPublicPageMetadata({
  title,
  description,
  path,
  image,
}: {
  title: string;
  description: string;
  path: string;
  image?: PublicPageImage;
}): Metadata {
  const socialImage = image ?? {
    path: SITE_OG_IMAGE_PATH,
    width: 1734,
    height: 907,
    alt: `${SITE_NAME}｜動画や写真からショート動画を自動編集`,
  };

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
          url: socialImage.path,
          width: socialImage.width,
          height: socialImage.height,
          alt: socialImage.alt,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [socialImage.path],
    },
  };
}

export const siteMetadataBase = new URL(SITE_ORIGIN);
