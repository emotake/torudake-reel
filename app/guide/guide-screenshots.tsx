/* eslint-disable @next/next/no-img-element -- Local, dimensioned product screenshots document the real UI. */
export type GuideScreenshot = {
  src: string;
  alt: string;
  title: string;
  description: string;
};

export default function GuideScreenshots({
  screenshots,
}: {
  screenshots: readonly GuideScreenshot[];
}) {
  return (
    <section className="guideScreens" aria-labelledby="guideScreensTitle">
      <div className="guideScreensHeading">
        <p className="guideProofLabel">実際の編集画面</p>
        <h2 id="guideScreensTitle">どこを選ぶか、画面で確認できます。</h2>
        <p>掲載画像は公開中のサンプル編集画面をそのまま記録したものです。</p>
      </div>
      <div className="guideScreensGrid">
        {screenshots.map((screenshot, index) => (
          <figure key={screenshot.src}>
            <span>0{index + 1}</span>
            <img src={screenshot.src} alt={screenshot.alt} loading="lazy" />
            <figcaption>
              <strong>{screenshot.title}</strong>
              <small>{screenshot.description}</small>
            </figcaption>
          </figure>
        ))}
      </div>
    </section>
  );
}
