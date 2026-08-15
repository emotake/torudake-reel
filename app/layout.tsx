import type { Metadata } from "next";
import { buildSiteStructuredData } from "../lib/seo";
import {
  buildPublicPageMetadata,
  siteMetadataBase,
} from "../lib/site-metadata";
import {
  SITE_DESCRIPTION,
  SITE_NAME,
  SITE_TITLE,
} from "../lib/site";
import GoogleAnalytics from "./google-analytics";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: siteMetadataBase,
  ...buildPublicPageMetadata({
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    path: "/",
  }),
  applicationName: SITE_NAME,
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/favicon-v2.svg", type: "image/svg+xml" },
      { url: "/favicon-v2-32.png", type: "image/png", sizes: "32x32" },
      { url: "/icon-192-v2.png", type: "image/png", sizes: "192x192" },
      { url: "/icon-512-v2.png", type: "image/png", sizes: "512x512" },
    ],
    shortcut: "/favicon.ico",
    apple: [
      {
        url: "/apple-touch-icon-v2.png",
        type: "image/png",
        sizes: "180x180",
      },
    ],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-video-preview": -1,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const structuredData = buildSiteStructuredData();

  return (
    <html lang="ja">
      <body>
        <a className="skipToContent" href="#main-content">
          本文へ移動
        </a>
        <GoogleAnalytics />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(structuredData).replace(/</g, "\\u003c"),
          }}
        />
        <div id="main-content" tabIndex={-1}>
          {children}
        </div>
      </body>
    </html>
  );
}
