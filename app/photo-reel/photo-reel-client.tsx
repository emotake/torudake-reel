"use client";

import Image from "next/image";
import Link from "next/link";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import {
  disposePhotoAssets,
  drawPhotoReelFrame,
  preparePhotoAssets,
  type PhotoReelSettings,
  type PhotoReelTemplateId,
  type PreparedPhotoAsset,
} from "../../lib/photo-reel";
import { exportPhotoReel } from "../../lib/photo-reel-export";

const MAX_PHOTOS = 10;
const MIN_PHOTOS = 2;
const MAX_PHOTO_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_BYTES = 250 * 1024 * 1024;
const MAX_AUDIO_BYTES = 30 * 1024 * 1024;

const TEMPLATE_OPTIONS: Array<{
  id: PhotoReelTemplateId;
  label: string;
  note: string;
  detail: string;
}> = [
  {
    id: "cinematic",
    label: "シネマ",
    note: "風景・旅行",
    detail: "ゆっくり寄る動きと深みのある切り替え",
  },
  {
    id: "upbeat",
    label: "リズム",
    note: "食事・イベント",
    detail: "小気味よいカットと弾むようなズーム",
  },
  {
    id: "editorial",
    label: "エディトリアル",
    note: "商品・お店",
    detail: "雑誌のような余白と洗練された見せ方",
  },
  {
    id: "memories",
    label: "ダイアリー",
    note: "日常・思い出",
    detail: "写真をめくるような柔らかい動き",
  },
  {
    id: "gallery",
    label: "クリーン",
    note: "写真をそのまま",
    detail: "横写真も切らずに、全体をすっきり表示",
  },
];

type ResultVideo = {
  blob: Blob;
  url: string;
  filename: string;
};

type PendingFinalize = {
  blob: Blob;
  reservationId: string;
};

class PhotoReelRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "PhotoReelRequestError";
  }
}

function isSupportedPhoto(file: File) {
  return new Set([
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/heic",
    "image/heif",
  ]).has(file.type.toLowerCase()) || /\.(jpe?g|png|webp|heic|heif)$/i.test(file.name);
}

function formatTime(seconds: number) {
  const safe = Math.max(0, Math.floor(seconds));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
}

function buildFilename() {
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    "-",
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
  ].join("");
  return `torudake-photo-reel-${stamp}.mp4`;
}

async function readError(response: Response, fallback: string) {
  const payload = (await response.json().catch(() => null)) as {
    error?: string;
  } | null;
  return payload?.error?.trim() || fallback;
}

async function reservePhotoUsage(duration: 15 | 30) {
  const requestBody = JSON.stringify({
    sourceDurationSeconds: duration,
    idempotencyKey: crypto.randomUUID(),
    creationType: "photo",
  });
  const requestReservation = () =>
    fetch("/api/usage/reserve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: requestBody,
    });

  let response = await requestReservation();
  if (response.status === 401) {
    const trialResponse = await fetch("/api/session/trial", { method: "POST" });
    if (!trialResponse.ok) {
      throw new PhotoReelRequestError(
        await readError(
          trialResponse,
          "無料体験を開始できませんでした。ページを再読み込みしてお試しください。",
        ),
        trialResponse.status,
      );
    }
    response = await requestReservation();
  }

  if (!response.ok) {
    throw new PhotoReelRequestError(
      await readError(response, "利用枠を確認できませんでした。"),
      response.status,
    );
  }

  const payload = (await response.json()) as {
    required?: boolean;
    reservationId?: string;
  };
  if (payload.required && !payload.reservationId) {
    throw new PhotoReelRequestError("利用枠を確認できませんでした。", 500);
  }
  return payload.required ? payload.reservationId ?? null : null;
}

async function updatePhotoUsage(
  action: "complete" | "release",
  reservationId: string,
) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(`/api/usage/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reservationId }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { completed?: boolean; released?: boolean; error?: string }
        | null;
      const confirmed =
        action === "complete" ? payload?.completed : payload?.released;
      if (response.ok && confirmed) return true;
      lastError = new Error(
        payload?.error ||
          (action === "complete"
            ? "利用記録を確定できませんでした。"
            : "利用枠を戻せませんでした。"),
      );
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("利用記録を確認できませんでした。");
}

function getFriendlyExportError(error: unknown) {
  if (error instanceof PhotoReelRequestError) return error.message;
  if (error instanceof DOMException && error.name === "AbortError") {
    return "書き出しを中止しました。利用枠は消費されません。";
  }
  if (error instanceof Error) {
    if (/support|codec|encoder|WebCodecs|VideoEncoder/i.test(error.message)) {
      return "このブラウザではMP4を書き出せません。SafariまたはChromeを最新版にしてお試しください。";
    }
    if (/memory|allocation|canvas|bitmap/i.test(error.message)) {
      return "写真の処理に必要なメモリが足りませんでした。他のアプリを閉じるか、写真の枚数を減らしてお試しください。";
    }
    if (error.message.trim()) return error.message;
  }
  return "動画を書き出せませんでした。写真を減らして、もう一度お試しください。";
}

export default function PhotoReelClient() {
  const photoInputRef = useRef<HTMLInputElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const photosRef = useRef<PreparedPhotoAsset[]>([]);
  const animationRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const resultRef = useRef<ResultVideo | null>(null);

  const [photos, setPhotos] = useState<PreparedPhotoAsset[]>([]);
  const [duration, setDuration] = useState<15 | 30>(15);
  const [templateId, setTemplateId] =
    useState<PhotoReelTemplateId>("cinematic");
  const [title, setTitle] = useState("");
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [audioPreviewUrl, setAudioPreviewUrl] = useState("");
  const [preparing, setPreparing] = useState(false);
  const [prepareProgress, setPrepareProgress] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [previewTime, setPreviewTime] = useState(0);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [result, setResult] = useState<ResultVideo | null>(null);
  const [pendingFinalize, setPendingFinalize] =
    useState<PendingFinalize | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [showPurchase, setShowPurchase] = useState(false);

  const settings = useMemo<PhotoReelSettings>(
    () => ({
      duration,
      templateId,
      title: title.trim() || undefined,
    }),
    [duration, templateId, title],
  );

  const lowResolutionCount = useMemo(
    () =>
      photos.filter(
        (photo) =>
          Math.min(photo.width, photo.height) < 1080 ||
          Math.max(photo.width, photo.height) < 1920,
      ).length,
    [photos],
  );

  useEffect(() => {
    photosRef.current = photos;
  }, [photos]);

  useEffect(() => {
    resultRef.current = result;
  }, [result]);

  useEffect(
    () => () => {
      if (audioPreviewUrl) URL.revokeObjectURL(audioPreviewUrl);
    },
    [audioPreviewUrl],
  );

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => {
      setReducedMotion(query.matches);
      if (query.matches) setIsPlaying(false);
    };
    update();
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);

  useEffect(
    () => () => {
      if (animationRef.current !== null) {
        cancelAnimationFrame(animationRef.current);
      }
      abortRef.current?.abort();
      disposePhotoAssets(photosRef.current);
      if (resultRef.current) URL.revokeObjectURL(resultRef.current.url);
    },
    [],
  );

  const clearResult = useCallback(() => {
    setShowPurchase(false);
    setPendingFinalize(null);
    setResult((current) => {
      if (current) URL.revokeObjectURL(current.url);
      return null;
    });
  }, []);

  const renderPreviewFrame = useCallback(
    (time: number) => {
      const canvas = canvasRef.current;
      if (!canvas || photos.length === 0) return;
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) return;
      drawPhotoReelFrame(context, photos, settings, time);
    },
    [photos, settings],
  );

  useEffect(() => {
    if (photos.length === 0) return;
    renderPreviewFrame(Math.min(previewTime, duration));
  }, [duration, photos.length, previewTime, renderPreviewFrame]);

  useEffect(() => {
    if (!isPlaying || photos.length === 0 || reducedMotion) return;
    let lastFrame = performance.now();
    let lastUiUpdate = lastFrame;
    let currentTime = previewTime >= duration ? 0 : previewTime;

    const tick = (now: number) => {
      if (now - lastFrame >= 1000 / 30) {
        currentTime += (now - lastFrame) / 1000;
        lastFrame = now;
        if (currentTime >= duration) currentTime %= duration;
        renderPreviewFrame(currentTime);
        if (now - lastUiUpdate >= 100) {
          setPreviewTime(currentTime);
          lastUiUpdate = now;
        }
      }
      animationRef.current = requestAnimationFrame(tick);
    };

    animationRef.current = requestAnimationFrame(tick);
    return () => {
      if (animationRef.current !== null) {
        cancelAnimationFrame(animationRef.current);
        animationRef.current = null;
      }
    };
  }, [duration, isPlaying, photos.length, previewTime, reducedMotion, renderPreviewFrame]);

  const addPhotos = async (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (chosen.length === 0 || preparing || exporting) return;

    setError("");
    setShowPurchase(false);
    setMessage("");
    const remaining = MAX_PHOTOS - photos.length;
    if (remaining <= 0) {
      setError("写真は最大10枚までです。不要な写真を削除してから追加してください。");
      return;
    }

    const invalid = chosen.filter((file) => !isSupportedPhoto(file));
    const oversized = chosen.filter((file) => file.size > MAX_PHOTO_BYTES);
    const accepted = chosen
      .filter(
        (file) => isSupportedPhoto(file) && file.size <= MAX_PHOTO_BYTES,
      )
      .slice(0, remaining);
    const existingBytes = photos.reduce((sum, photo) => sum + photo.file.size, 0);
    const totalBytes = accepted.reduce((sum, file) => sum + file.size, existingBytes);

    if (invalid.length > 0 || oversized.length > 0) {
      setError(
        "読み込めない写真がありました。JPEG・PNG・WebP・HEIC・HEIF、1枚50MB以下でお試しください。",
      );
    }
    if (chosen.length > remaining) {
      setMessage(`最大10枚のため、先頭から${remaining}枚を追加します。`);
    }
    if (totalBytes > MAX_TOTAL_BYTES) {
      setError(
        "写真の合計サイズが250MBを超えています。枚数を減らすか、写真を軽くしてお試しください。",
      );
      return;
    }
    if (accepted.length === 0) return;

    setPreparing(true);
    setPrepareProgress(0);
    setIsPlaying(false);
    clearResult();
    const prepared: PreparedPhotoAsset[] = [];
    const failed: string[] = [];

    for (let index = 0; index < accepted.length; index += 1) {
      const file = accepted[index];
      try {
        const assets = await preparePhotoAssets([file], (fileProgress) => {
          setPrepareProgress((index + fileProgress) / accepted.length);
        });
        if (assets[0]) prepared.push(assets[0]);
      } catch {
        failed.push(file.name);
      }
    }

    if (prepared.length > 0) {
      setPhotos((current) => [...current, ...prepared]);
      setPreviewTime(0);
      setMessage(
        `${prepared.length}枚を追加しました。順番と仕上がりを確認できます。`,
      );
    }
    if (failed.length > 0) {
      setError(
        `読み込めない写真が${failed.length}枚ありました。iPhoneで変換が必要な場合は、写真アプリからJPEGとして共有してお試しください。`,
      );
    }
    setPrepareProgress(1);
    setPreparing(false);
  };

  const movePhoto = (index: number, direction: -1 | 1) => {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= photos.length || exporting) return;
    setPhotos((current) => {
      const next = [...current];
      [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
      return next;
    });
    setPreviewTime(0);
    setIsPlaying(false);
    clearResult();
  };

  const removePhoto = (index: number) => {
    if (exporting) return;
    setPhotos((current) => {
      const target = current[index];
      if (target) disposePhotoAssets([target]);
      return current.filter((_, itemIndex) => itemIndex !== index);
    });
    setPreviewTime(0);
    setIsPlaying(false);
    clearResult();
  };

  const handleAudio = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    event.target.value = "";
    if (!file) return;
    if (
      (!file.type.startsWith("audio/") &&
        !/\.(mp3|m4a|wav|aac)$/i.test(file.name)) ||
      file.size > MAX_AUDIO_BYTES
    ) {
      setError("音源は30MB以下のMP3・M4A・WAVなどを選んでください。");
      return;
    }
    setAudioFile(file);
    setAudioPreviewUrl(URL.createObjectURL(file));
    setError("");
    setShowPurchase(false);
    clearResult();
  };

  const finalizeResult = useCallback((blob: Blob) => {
    if (blob.size < 1024) throw new Error("完成動画のデータが空でした。");
    const nextResult = {
      blob,
      url: URL.createObjectURL(blob),
      filename: buildFilename(),
    };
    setResult((current) => {
      if (current) URL.revokeObjectURL(current.url);
      return nextResult;
    });
    setPendingFinalize(null);
    setMessage("1080×1920のMP4動画が完成しました。保存または共有できます。");
  }, []);

  const startExport = async () => {
    if (photos.length < MIN_PHOTOS || preparing || exporting) return;
    clearResult();
    setError("");
    setMessage("");
    setShowPurchase(false);
    setExporting(true);
    setExportProgress(0);
    setIsPlaying(false);
    const controller = new AbortController();
    abortRef.current = controller;
    let reservationId: string | null = null;
    let videoCreated = false;

    try {
      reservationId = await reservePhotoUsage(duration);
      const blob = await exportPhotoReel(photos, settings, {
        audioFile: audioFile ?? undefined,
        audioFit: "loop",
        signal: controller.signal,
        onProgress: (value) => setExportProgress(value),
      });
      videoCreated = true;
      if (reservationId) {
        try {
          await updatePhotoUsage("complete", reservationId);
        } catch {
          setPendingFinalize({ blob, reservationId });
          setError(
            "動画は完成しましたが、利用記録を確認できませんでした。通信を確認して再試行してください。",
          );
          return;
        }
      }
      finalizeResult(blob);
      setExportProgress(1);
    } catch (caught) {
      setShowPurchase(
        caught instanceof PhotoReelRequestError && caught.status === 402,
      );
      if (reservationId && !videoCreated) {
        try {
          await updatePhotoUsage("release", reservationId);
        } catch {
          setError(
            `${getFriendlyExportError(caught)} 利用枠の戻し処理も通信できませんでした。しばらく待ってから再度お試しください。`,
          );
          return;
        }
      }
      setError(getFriendlyExportError(caught));
    } finally {
      abortRef.current = null;
      setExporting(false);
    }
  };

  const retryFinalize = async () => {
    if (!pendingFinalize || exporting) return;
    setExporting(true);
    setError("");
    try {
      await updatePhotoUsage("complete", pendingFinalize.reservationId);
      finalizeResult(pendingFinalize.blob);
    } catch (caught) {
      setError(getFriendlyExportError(caught));
    } finally {
      setExporting(false);
    }
  };

  const saveResult = async () => {
    if (!result) return;
    setError("");
    const file = new File([result.blob], result.filename, { type: "video/mp4" });
    const shareData: ShareData = {
      files: [file],
      title: "撮るだけリールで作成した写真リール",
    };

    try {
      if (
        typeof navigator.share === "function" &&
        (!navigator.canShare || navigator.canShare(shareData))
      ) {
        await navigator.share(shareData);
        return;
      }
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
    }

    const anchor = document.createElement("a");
    anchor.href = result.url;
    anchor.download = result.filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  };

  const updateDuration = (next: 15 | 30) => {
    if (exporting) return;
    setDuration(next);
    setPreviewTime(0);
    setIsPlaying(false);
    clearResult();
  };

  const updateTemplate = (next: PhotoReelTemplateId) => {
    if (exporting) return;
    setTemplateId(next);
    setPreviewTime(0);
    setIsPlaying(false);
    clearResult();
  };

  return (
    <main className="photoReelShell">
      <header className="photoReelTopbar">
        <Link className="photoReelBrand" href="/" aria-label="撮るだけリールのトップへ">
          <span className="photoReelBrandIcon" aria-hidden="true">
            ▶<i />
          </span>
          <span>
            撮るだけリール
            <small>写真から作る</small>
          </span>
        </Link>
        <nav aria-label="写真リールのナビゲーション">
          <Link href="/">動画から作る</Link>
          <Link href="/account">アカウント</Link>
        </nav>
      </header>

      <section className="photoReelIntro">
        <p className="photoReelEyebrow">PHOTO TO REEL · 端末内編集</p>
        <h1>
          写真を選ぶだけ。
          <br />
          <em>動きのある1本に。</em>
        </h1>
        <p>
          日常で撮った写真を2〜10枚選び、5つの仕上がりから選ぶだけ。
          <br />
          写真そのものは送信せず、スマホやパソコンの中でリール動画にします。
        </p>
        <div className="photoReelTrust">
          <span>追加API料金 0円</span>
          <span>1080×1920 MP4</span>
          <span>横写真も切らずに対応</span>
        </div>
      </section>

      <section className="photoReelWorkspace" aria-label="写真リール編集">
        <div className="photoReelPreviewPanel">
          <div className="photoReelPreviewHeading">
            <span>仕上がりプレビュー</span>
            <small>{photos.length > 0 ? `${photos.length}枚 · ${duration}秒` : "9:16"}</small>
          </div>
          <div className="photoReelPhone">
            {photos.length > 0 ? (
              <canvas
                ref={canvasRef}
                width={1080}
                height={1920}
                aria-label="写真リールの仕上がりプレビュー"
              />
            ) : (
              <div className="photoReelEmptyPreview">
                <span aria-hidden="true">＋</span>
                <strong>写真を選ぶと、ここで動きを確認できます</strong>
                <small>2〜10枚 · JPEG / PNG / WebP / HEIC</small>
              </div>
            )}
          </div>

          <div className="photoReelPlayback">
            <button
              type="button"
              onClick={() => setIsPlaying((current) => !current)}
              disabled={photos.length === 0 || reducedMotion}
              aria-label={isPlaying ? "プレビューを一時停止" : "プレビューを再生"}
            >
              {isPlaying ? "Ⅱ" : "▶"}
            </button>
            <input
              type="range"
              min={0}
              max={duration}
              step={0.05}
              value={Math.min(previewTime, duration)}
              disabled={photos.length === 0}
              aria-label="プレビューの再生位置"
              onChange={(event) => {
                setIsPlaying(false);
                setPreviewTime(Number(event.target.value));
              }}
            />
            <span>
              {formatTime(previewTime)} / {formatTime(duration)}
            </span>
          </div>
          {reducedMotion ? (
            <p className="photoReelMotionNote">
              端末の動きを減らす設定に合わせ、自動再生を停止しています。シークバーで確認できます。
            </p>
          ) : null}
          <div className="photoReelOutputFacts">
            <span>
              <strong>1080 × 1920</strong>
              実際の書き出し解像度
            </span>
            <span>
              <strong>MP4</strong>
              Instagram向け
            </span>
          </div>
          {lowResolutionCount > 0 ? (
            <p className="photoReelQualityNote">
              {lowResolutionCount}枚は元写真の解像度が低いため、その部分だけ鮮明さに限界があります。サービス側では1080×1920で書き出します。
            </p>
          ) : null}
        </div>

        <div className="photoReelControls">
          <section className="photoReelControlSection">
            <div className="photoReelSectionHeading">
              <span>01</span>
              <div>
                <h2>写真を選ぶ</h2>
                <p>おすすめは4〜8枚。選んだ順に並びます。</p>
              </div>
              <strong>{photos.length} / 10</strong>
            </div>
            <input
              ref={photoInputRef}
              className="visuallyHidden"
              type="file"
              accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.jpg,.jpeg,.png,.webp,.heic,.heif"
              multiple
              onChange={addPhotos}
            />
            <button
              className="photoReelAddButton"
              type="button"
              onClick={() => photoInputRef.current?.click()}
              disabled={preparing || exporting || photos.length >= MAX_PHOTOS}
            >
              <span aria-hidden="true">＋</span>
              <span>
                <strong>{photos.length === 0 ? "写真を選ぶ" : "写真を追加する"}</strong>
                <small>iPhoneのHEICにも対応 · 最大10枚</small>
              </span>
            </button>
            {preparing ? (
              <div className="photoReelPreparing" aria-live="polite">
                <span style={{ width: `${Math.round(prepareProgress * 100)}%` }} />
                <p>写真を端末内で準備中… {Math.round(prepareProgress * 100)}%</p>
              </div>
            ) : null}

            {photos.length > 0 ? (
              <ol className="photoReelPhotoList" aria-label="写真の再生順">
                {photos.map((photo, index) => (
                  <li key={photo.id}>
                    <span className="photoReelPhotoNumber">{index + 1}</span>
                    <span className="photoReelThumb">
                      <Image
                        src={photo.previewUrl}
                        alt={`${index + 1}枚目: ${photo.name}`}
                        width={76}
                        height={76}
                        unoptimized
                      />
                    </span>
                    <span className="photoReelPhotoInfo">
                      <strong>{photo.name}</strong>
                      <small>
                        {photo.width}×{photo.height}
                      </small>
                    </span>
                    <span className="photoReelPhotoActions">
                      <button
                        type="button"
                        onClick={() => movePhoto(index, -1)}
                        disabled={index === 0 || exporting}
                        aria-label={`${photo.name}を1つ前へ`}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        onClick={() => movePhoto(index, 1)}
                        disabled={index === photos.length - 1 || exporting}
                        aria-label={`${photo.name}を1つ後ろへ`}
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        className="photoReelDelete"
                        onClick={() => removePhoto(index)}
                        disabled={exporting}
                        aria-label={`${photo.name}を削除`}
                      >
                        ×
                      </button>
                    </span>
                  </li>
                ))}
              </ol>
            ) : null}
          </section>

          <section className="photoReelControlSection">
            <div className="photoReelSectionHeading">
              <span>02</span>
              <div>
                <h2>動画の長さ</h2>
                <p>写真の表示時間は自動で均等に整えます。</p>
              </div>
            </div>
            <div className="photoReelSegmented" role="radiogroup" aria-label="動画の長さ">
              {([15, 30] as const).map((seconds) => (
                <button
                  key={seconds}
                  type="button"
                  role="radio"
                  aria-checked={duration === seconds}
                  className={duration === seconds ? "isActive" : ""}
                  disabled={exporting}
                  onClick={() => updateDuration(seconds)}
                >
                  <strong>{seconds}秒</strong>
                  <small>{seconds === 15 ? "テンポよく" : "ゆったり見せる"}</small>
                </button>
              ))}
            </div>
          </section>

          <section className="photoReelControlSection">
            <div className="photoReelSectionHeading">
              <span>03</span>
              <div>
                <h2>自動編集を選ぶ</h2>
                <p>動きもテンポも異なる5パターンです。API料金は変わりません。</p>
              </div>
            </div>
            <div className="photoReelTemplateGrid" role="radiogroup" aria-label="自動編集パターン">
              {TEMPLATE_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={templateId === option.id}
                  data-template={option.id}
                  className={templateId === option.id ? "isActive" : ""}
                  disabled={exporting}
                  onClick={() => updateTemplate(option.id)}
                >
                  <span className="photoReelTemplateVisual" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                  </span>
                  <span>
                    <strong>{option.label}</strong>
                    <small>{option.note}</small>
                  </span>
                  <p>{option.detail}</p>
                  {option.id === "cinematic" ? <em>おすすめ</em> : null}
                </button>
              ))}
            </div>
          </section>

          <section className="photoReelControlSection">
            <div className="photoReelSectionHeading">
              <span>04</span>
              <div>
                <h2>文字と音を整える</h2>
                <p>どちらも任意です。追加のAPI料金はかかりません。</p>
              </div>
            </div>
            <label className="photoReelField">
              <span>
                最初に入れるタイトル
                <small>{title.length} / 42</small>
              </span>
              <input
                type="text"
                value={title}
                maxLength={42}
                placeholder="例：週末の小さな旅"
                disabled={exporting}
                onChange={(event) => {
                  setTitle(event.target.value);
                  setPreviewTime(0);
                  clearResult();
                }}
              />
            </label>
            <input
              ref={audioInputRef}
              className="visuallyHidden"
              type="file"
              accept="audio/*,.mp3,.m4a,.wav,.aac"
              onChange={handleAudio}
            />
            <div className="photoReelAudioRow">
              <div>
                <strong>BGM</strong>
                <p>
                  {audioFile ? audioFile.name : "音なし（初期設定）"}
                </p>
                <small>権利を持つ音源だけをご利用ください。</small>
              </div>
              <button
                type="button"
                onClick={() => audioInputRef.current?.click()}
                disabled={exporting}
              >
                {audioFile ? "変更" : "音源を選ぶ"}
              </button>
              {audioFile ? (
                <button
                  type="button"
                  className="photoReelAudioRemove"
                  onClick={() => {
                    setAudioFile(null);
                    setAudioPreviewUrl("");
                    clearResult();
                  }}
                  disabled={exporting}
                >
                  音なしに戻す
                </button>
              ) : null}
              {audioPreviewUrl ? (
                <audio
                  className="photoReelAudioPreview"
                  src={audioPreviewUrl}
                  controls
                  preload="metadata"
                  aria-label="選択したBGMを試聴"
                />
              ) : null}
            </div>
          </section>

          <section className="photoReelExportCard">
            <div>
              <span className="photoReelExportIcon" aria-hidden="true">MP4</span>
              <span>
                <strong>高画質で書き出す</strong>
                <small>1080×1920 · 1動画作成分</small>
              </span>
            </div>
            <ul>
              <li>写真と音源は端末外へ送信しません</li>
              <li>書き出し成功時だけ利用枠を1本分使用します</li>
              <li>OpenAI API料金は発生しません</li>
            </ul>
            <button
              className="photoReelExportButton"
              type="button"
              onClick={startExport}
              disabled={photos.length < MIN_PHOTOS || preparing || exporting || Boolean(pendingFinalize)}
            >
              {exporting ? `動画を作成中… ${Math.round(exportProgress * 100)}%` : "写真リールを書き出す"}
              <span aria-hidden="true">↓</span>
            </button>
            {photos.length === 1 ? (
              <p className="photoReelMinimumNote">あと1枚追加すると書き出せます。</p>
            ) : null}
            {exporting ? (
              <div className="photoReelExportProgress" aria-live="polite">
                <span style={{ width: `${Math.max(2, Math.round(exportProgress * 100))}%` }} />
              </div>
            ) : null}
            {exporting ? (
              <button
                className="photoReelCancelButton"
                type="button"
                onClick={() => abortRef.current?.abort()}
              >
                書き出しを中止
              </button>
            ) : null}
            {pendingFinalize ? (
              <button
                className="photoReelRetryButton"
                type="button"
                onClick={retryFinalize}
                disabled={exporting}
              >
                利用確認を再試行して保存へ進む
              </button>
            ) : null}
          </section>

          <div className="photoReelStatus" aria-live="polite">
            {error ? <p className="photoReelError">{error}</p> : null}
            {showPurchase ? (
              <Link className="photoReelPurchaseLink" href="/account?checkout=one_time">
                1動画作成（200円）を確認する →
              </Link>
            ) : null}
            {message ? <p className="photoReelMessage">{message}</p> : null}
          </div>

          {result ? (
            <section className="photoReelResult">
              <div>
                <span aria-hidden="true">✓</span>
                <div>
                  <h2>写真リールが完成しました</h2>
                  <p>1080×1920 · MP4 · {duration}秒</p>
                </div>
              </div>
              <video src={result.url} controls playsInline preload="metadata" />
              <button type="button" onClick={saveResult}>
                iPhoneへ保存・共有
                <span aria-hidden="true">↓</span>
              </button>
              <small>同じ完成動画は何度保存しても追加消費されません。</small>
            </section>
          ) : null}
        </div>
      </section>

      <section className="photoReelHow">
        <p className="photoReelEyebrow">HOW IT WORKS</p>
        <h2>写真の魅力を残したまま、動画らしい動きを。</h2>
        <div>
          <article>
            <span>01</span>
            <strong>2〜10枚を選ぶ</strong>
            <p>横写真も無理に縦へ切らず、ぼかし背景で全体を残します。</p>
          </article>
          <article>
            <span>02</span>
            <strong>5パターンから選ぶ</strong>
            <p>プレビューで動きを見比べ、写真に合う雰囲気を決めます。</p>
          </article>
          <article>
            <span>03</span>
            <strong>MP4で保存する</strong>
            <p>Instagramへ投稿しやすい縦1080pで端末内書き出しします。</p>
          </article>
        </div>
      </section>

      <footer className="photoReelFooter">
        <strong>撮るだけリール</strong>
        <p>写真も動画も、編集で止まらず投稿へ。</p>
        <nav aria-label="フッターナビゲーション">
          <Link href="/">動画から作る</Link>
          <Link href="/privacy">プライバシー</Link>
          <Link href="/terms">利用規約</Link>
          <Link href="/commercial-disclosure">特定商取引法に基づく表記</Link>
        </nav>
      </footer>
    </main>
  );
}
