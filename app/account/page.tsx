import {
  chatGPTSignInPath,
  chatGPTSignOutPath,
  getChatGPTUser,
} from "../chatgpt-auth";
import AccountClient from "./account-client";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function AccountPage() {
  const user = await getChatGPTUser();

  if (!user) {
    return (
      <main className="accountPage">
        <section className="accountSignInCard">
          <Link className="accountBrand" href="/">
            <span>▶</span>
            撮るだけリール
          </Link>
          <p className="eyebrow">ACCOUNT</p>
          <h1>利用枠とお支払いを、ひとつの画面で。</h1>
          <p>
            無料体験の残り、購入した動画数、月額プランの更新日を安全に管理します。
          </p>
          <a
            className="accountPrimaryAction"
            href={chatGPTSignInPath("/account")}
          >
            アカウントにログイン
          </a>
          <small>
            現在はChatGPTの安全な認証を利用します。カード情報はStripeが管理します。
          </small>
        </section>
      </main>
    );
  }

  return (
    <AccountClient
      displayName={user.displayName}
      email={user.email}
      signOutPath={chatGPTSignOutPath("/")}
    />
  );
}
