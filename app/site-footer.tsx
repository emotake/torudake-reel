import Image from "next/image";
import Link from "next/link";
import { getPublicSocialLinks } from "../lib/site-socials";

const FOOTER_GROUPS = [
  {
    id: "create",
    title: "作る",
    links: [
      { href: "/#create", label: "作り方を選ぶ" },
      { href: "/video-edit", label: "1本の動画を整える" },
      { href: "/video-mix", label: "複数の動画をつなぐ" },
      { href: "/photo-reel", label: "写真から作る" },
    ],
  },
  {
    id: "guides",
    title: "ガイド",
    links: [
      { href: "/guide", label: "動画編集ガイド一覧" },
      { href: "/guide/instagram-reels-editing", label: "Instagramリールの編集" },
      { href: "/guide/automatic-video-captions", label: "動画にテロップを自動生成" },
      { href: "/guide/youtube-shorts-editing", label: "YouTubeショートの編集" },
      { href: "/guide/iphone-mov-reel", label: "iPhone動画の編集" },
      { href: "/guide/silent-video-narration", label: "無音動画にAI音声" },
      { href: "/guide/japanese-reading", label: "読み方を修正する" },
    ],
  },
  {
    id: "support",
    title: "料金・サポート",
    links: [
      { href: "/pricing", label: "料金を見る" },
      { href: "/support", label: "よくある質問・お問い合わせ" },
    ],
  },
  {
    id: "legal",
    title: "サービス情報",
    links: [
      { href: "/privacy", label: "プライバシーポリシー" },
      { href: "/terms", label: "利用規約" },
      { href: "/commercial-disclosure", label: "特定商取引法に基づく表記" },
    ],
  },
] as const;

type SiteFooterProps = {
  preserveWorkspace?: boolean;
};

export default function SiteFooter({
  preserveWorkspace = false,
}: SiteFooterProps) {
  const navigationTarget = preserveWorkspace ? "_blank" : undefined;
  const navigationRel = preserveWorkspace ? "noreferrer" : undefined;
  const socialLinks = getPublicSocialLinks();

  return (
    <footer className="siteFooter" aria-labelledby="siteFooterTitle">
      <div className="siteFooterInner">
        <section className="siteFooterBrand">
          <h2 id="siteFooterTitle">
            <Link
              className="siteFooterBrandLink"
              href="/"
              target={navigationTarget}
              rel={navigationRel}
              aria-label={
                preserveWorkspace
                  ? "撮るだけリールのトップ（新しいタブで開く）"
                  : undefined
              }
            >
              <Image src="/favicon-v2.svg" width={48} height={48} alt="" />
              <span>
                <strong>撮るだけリール</strong>
                <small>動画や写真から、投稿できるショート動画へ</small>
              </span>
            </Link>
          </h2>
          <p className="siteFooterDescription">
            素材に合う作り方を選び、必要な編集だけを迷わず進められます。
          </p>
          <p className="siteFooterPromise">
            初回・上限つきで編集とプレビューを試せます。仕上がりを見てから保存方法を選べます。
          </p>
          {socialLinks.length > 0 ? (
            <nav className="siteFooterSocials" aria-label="公式SNS">
              {socialLinks.map((social) => (
                <a
                  key={social.id}
                  href={social.href}
                  target="_blank"
                  rel="me noreferrer"
                >
                  公式{social.label}
                </a>
              ))}
            </nav>
          ) : null}
          {preserveWorkspace ? (
            <p className="siteFooterWorkspaceNote">
              編集内容を守るため、リンクは新しいタブで開きます。
            </p>
          ) : null}
        </section>

        <nav className="siteFooterNav" aria-label="フッターメニュー">
          {FOOTER_GROUPS.map((group) => (
            <section
              className="siteFooterGroup"
              aria-labelledby={`siteFooter-${group.id}`}
              key={group.id}
            >
              <h3 id={`siteFooter-${group.id}`}>{group.title}</h3>
              <ul>
                {group.links.map((link) => (
                  <li key={link.href}>
                    <Link
                      href={link.href}
                      target={navigationTarget}
                      rel={navigationRel}
                      aria-label={
                        preserveWorkspace
                          ? `${link.label}（新しいタブで開く）`
                          : undefined
                      }
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </nav>
      </div>

      <div className="siteFooterBottom">
        <small>© 2026 撮るだけリール</small>
        <span>最大1080p・透かしなし</span>
      </div>
    </footer>
  );
}
