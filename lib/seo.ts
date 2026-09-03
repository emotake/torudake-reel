import {
  FREE_SECONDS_LIMIT,
  FREE_VIDEO_LIMIT,
  ONE_TIME_PLAN_LABEL,
  ONE_TIME_PRICE_JPY,
  STARTER_MONTHLY_PRICE_JPY,
  STARTER_MONTHLY_PLAN_LABEL,
  STARTER_MONTHLY_VIDEO_LIMIT,
  STANDARD_MONTHLY_PRICE_JPY,
  STANDARD_MONTHLY_PLAN_LABEL,
  STANDARD_MONTHLY_VIDEO_LIMIT,
} from "./billing-policy";
import {
  SITE_DESCRIPTION,
  SITE_LAST_MODIFIED,
  SITE_NAME,
  SITE_OG_IMAGE_PATH,
  SITE_ORIGIN,
  siteUrl,
} from "./site";

export function buildSiteStructuredData() {
  const freeMinutes = Math.floor(FREE_SECONDS_LIMIT / 60);

  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": `${SITE_ORIGIN}/#organization`,
        url: `${SITE_ORIGIN}/`,
        name: SITE_NAME,
        logo: {
          "@type": "ImageObject",
          url: siteUrl("/icon-512-v2.png"),
          width: 512,
          height: 512,
        },
        email: "torudake.reel@gmail.com",
        contactPoint: {
          "@type": "ContactPoint",
          contactType: "customer support",
          email: "torudake.reel@gmail.com",
          availableLanguage: "Japanese",
        },
      },
      {
        "@type": "WebSite",
        "@id": `${SITE_ORIGIN}/#website`,
        url: `${SITE_ORIGIN}/`,
        name: SITE_NAME,
        alternateName: "撮るだけリール",
        description: SITE_DESCRIPTION,
        inLanguage: "ja-JP",
        dateModified: SITE_LAST_MODIFIED,
        publisher: { "@id": `${SITE_ORIGIN}/#organization` },
      },
      {
        "@type": "SoftwareApplication",
        "@id": `${SITE_ORIGIN}/#application`,
        url: `${SITE_ORIGIN}/`,
        name: SITE_NAME,
        description: SITE_DESCRIPTION,
        image: siteUrl(SITE_OG_IMAGE_PATH),
        applicationCategory: "MultimediaApplication",
        applicationSubCategory: "Video editing application",
        operatingSystem: "iOS, Android, Windows, macOS",
        browserRequirements:
          "JavaScript対応の最新Safari、Google Chrome、Microsoft Edge",
        inLanguage: "ja-JP",
        dateModified: SITE_LAST_MODIFIED,
        isAccessibleForFree: true,
        termsOfService: siteUrl("/terms"),
        provider: { "@id": `${SITE_ORIGIN}/#organization` },
        featureList: [
          "動画の自動カット",
          "日本語音声の自動文字起こし",
          "自動テロップ",
          "AIナレーション",
          "最大5本の動画を素材順に保って自動編集",
          "最大10枚の写真から縦型リールを自動作成",
          "写真リールの5種類の自動編集",
          "投稿用表紙の生成",
          "AIナレーションモードでInstagram投稿文を作成",
          "Instagramリール・YouTubeショート向けの縦型動画作成",
        ],
        offers: [
          {
            "@type": "Offer",
            name: "無料体験（編集・プレビュー）",
            description: `合計${freeMinutes}分以内・動画${FREE_VIDEO_LIMIT}本まで（いずれか先に達するまで）。完成動画の保存は有料です。`,
            price: 0,
            priceCurrency: "JPY",
            availability: "https://schema.org/InStock",
          },
          {
            "@type": "Offer",
            name: ONE_TIME_PLAN_LABEL,
            description: "1回の購入で完成動画を1本まで保存できます。月額料金はありません。表示価格は税込です。",
            price: ONE_TIME_PRICE_JPY,
            priceCurrency: "JPY",
            availability: "https://schema.org/InStock",
          },
          {
            "@type": "Offer",
            name: STARTER_MONTHLY_PLAN_LABEL,
            description: `1か月に動画${STARTER_MONTHLY_VIDEO_LIMIT}本まで保存できます。1か月ごとの自動更新です。表示価格は税込です。`,
            price: STARTER_MONTHLY_PRICE_JPY,
            priceCurrency: "JPY",
            availability: "https://schema.org/InStock",
            priceSpecification: {
              "@type": "UnitPriceSpecification",
              price: STARTER_MONTHLY_PRICE_JPY,
              priceCurrency: "JPY",
              billingDuration: "P1M",
            },
          },
          {
            "@type": "Offer",
            name: STANDARD_MONTHLY_PLAN_LABEL,
            description: `1か月に動画${STANDARD_MONTHLY_VIDEO_LIMIT}本まで保存できます。1か月ごとの自動更新です。表示価格は税込です。`,
            price: STANDARD_MONTHLY_PRICE_JPY,
            priceCurrency: "JPY",
            availability: "https://schema.org/InStock",
            priceSpecification: {
              "@type": "UnitPriceSpecification",
              price: STANDARD_MONTHLY_PRICE_JPY,
              priceCurrency: "JPY",
              billingDuration: "P1M",
            },
          },
        ],
      },
      {
        "@type": "VideoObject",
        "@id": `${SITE_ORIGIN}/#product-demo`,
        name: "撮るだけリール 編集後デモ",
        description:
          "風景動画に自動編集とテロップを加えた、撮るだけリールの仕上がり例です。",
        thumbnailUrl: siteUrl("/demo/torudake-demo-poster.jpg"),
        uploadDate: "2026-08-12",
        duration: "PT10.4S",
        contentUrl: siteUrl("/demo/torudake-demo.mp4"),
        inLanguage: "ja-JP",
      },
    ],
  };
}

export type PublicBreadcrumb = {
  name: string;
  path: string;
};

export function buildPublicPageStructuredData({
  name,
  description,
  path,
  breadcrumbs,
}: {
  name: string;
  description: string;
  path: string;
  breadcrumbs?: readonly PublicBreadcrumb[];
}) {
  const pageUrl = siteUrl(path);
  const trail = breadcrumbs ?? [
    { name: SITE_NAME, path: "/" },
    { name, path },
  ];

  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebPage",
        "@id": `${pageUrl}#webpage`,
        url: pageUrl,
        name,
        description,
        inLanguage: "ja-JP",
        dateModified: SITE_LAST_MODIFIED,
        isPartOf: { "@id": `${SITE_ORIGIN}/#website` },
        about: { "@id": `${SITE_ORIGIN}/#application` },
        primaryImageOfPage: {
          "@type": "ImageObject",
          url: siteUrl(SITE_OG_IMAGE_PATH),
        },
      },
      {
        "@type": "BreadcrumbList",
        "@id": `${pageUrl}#breadcrumb`,
        itemListElement: trail.map((item, index) => ({
          "@type": "ListItem",
          position: index + 1,
          name: item.name,
          item: siteUrl(item.path),
        })),
      },
    ],
  };
}

export function buildGuideStructuredData({
  name,
  description,
  path,
}: {
  name: string;
  description: string;
  path: string;
}) {
  const pageUrl = siteUrl(path);
  const page = buildPublicPageStructuredData({
    name,
    description,
    path,
    breadcrumbs: [
      { name: SITE_NAME, path: "/" },
      { name: "動画編集ガイド", path: "/guide" },
      { name, path },
    ],
  });

  return {
    ...page,
    "@graph": [
      ...page["@graph"],
      {
        "@type": "Article",
        "@id": `${pageUrl}#article`,
        headline: name,
        description,
        inLanguage: "ja-JP",
        datePublished: "2026-08-12",
        dateModified: SITE_LAST_MODIFIED,
        mainEntityOfPage: { "@id": `${pageUrl}#webpage` },
        image: siteUrl(SITE_OG_IMAGE_PATH),
        publisher: { "@id": `${SITE_ORIGIN}/#organization` },
      },
    ],
  };
}
