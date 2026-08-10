import {
  ONE_TIME_PRICE_JPY,
  STARTER_MONTHLY_PRICE_JPY,
  STARTER_MONTHLY_VIDEO_LIMIT,
  STANDARD_MONTHLY_PRICE_JPY,
  STANDARD_MONTHLY_VIDEO_LIMIT,
} from "./billing-policy";
import {
  SITE_DESCRIPTION,
  SITE_NAME,
  SITE_OG_IMAGE_PATH,
  SITE_ORIGIN,
  siteUrl,
} from "./site";

export function buildSiteStructuredData() {
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebSite",
        "@id": `${SITE_ORIGIN}/#website`,
        url: `${SITE_ORIGIN}/`,
        name: SITE_NAME,
        description: SITE_DESCRIPTION,
        inLanguage: "ja-JP",
      },
      {
        "@type": "WebApplication",
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
        isAccessibleForFree: true,
        featureList: [
          "動画の自動カット",
          "日本語音声の自動文字起こし",
          "自動テロップ",
          "AIナレーション",
          "最大10枚の写真から縦型リールを自動作成",
          "写真リールの5種類の自動編集",
          "投稿用表紙の生成",
          "AIナレーションモードでInstagram投稿文を作成",
        ],
        offers: [
          {
            "@type": "Offer",
            name: "無料体験（編集・プレビュー）",
            price: 0,
            priceCurrency: "JPY",
            availability: "https://schema.org/InStock",
          },
          {
            "@type": "Offer",
            name: "1動画作成",
            price: ONE_TIME_PRICE_JPY,
            priceCurrency: "JPY",
            availability: "https://schema.org/InStock",
          },
          {
            "@type": "Offer",
            name: `Starter（月${STARTER_MONTHLY_VIDEO_LIMIT}本）`,
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
            name: `Standard（月${STANDARD_MONTHLY_VIDEO_LIMIT}本）`,
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
    ],
  };
}
