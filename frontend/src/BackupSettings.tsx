import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";

type BackupPreferences = {
  path: string;
  auto_enabled: boolean;
  last_success_at: string | null;
  last_checked_at: string | null;
  last_path: string | null;
  error: string | null;
};
type BackupResult = { path: string; book_count: number; created_at: string };

export function BackupSettings() {
  const client = useQueryClient();
  const settings = useQuery({
    queryKey: ["backup-settings"],
    queryFn: () => api<BackupPreferences>("/settings/backup"),
    refetchInterval: 30_000,
  });
  const [draft, setDraft] = useState<string | null>(null);
  const [autoDraft, setAutoDraft] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [result, setResult] = useState<BackupResult | null>(null);
  const path = draft ?? settings.data?.path ?? "";
  const autoEnabled = autoDraft ?? settings.data?.auto_enabled ?? true;

  async function save(create: boolean) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    setResult(null);
    try {
      const saved = await api<BackupPreferences>("/settings/backup", {
        method: "PUT",
        body: JSON.stringify({ path, auto_enabled: autoEnabled }),
      });
      client.setQueryData(["backup-settings"], saved);
      setDraft(null);
      setAutoDraft(null);
      if (create) {
        setResult(await api<BackupResult>("/backups", { method: "POST" }));
        await client.invalidateQueries({ queryKey: ["backup-settings"] });
      } else {
        setNotice(
          autoEnabled
            ? "자동 백업 설정을 저장했습니다. 새로 설정한 경로는 1분 안에 확인하며, 이후 30분마다 변경 사항을 확인합니다."
            : "자동 백업을 껐습니다. ‘지금 백업’으로 수동 백업할 수 있습니다.",
        );
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="backup-settings" aria-busy={busy}>
      <strong>학습 데이터 백업</strong>
      <p>
        모든 책의 원본 PDF, 대화, 독서 위치와 앱 설정을 새 폴더에 보관합니다.
        성공한 새 백업을 만든 뒤 이 앱에서 관리하는 최근 백업 10개를 유지합니다.
      </p>
      <label>
        백업 폴더 경로
        <input
          value={path}
          placeholder="/Volumes/외장디스크/학습백업"
          maxLength={4096}
          disabled={busy || !settings.data}
          onChange={(event) => setDraft(event.target.value)}
        />
      </label>
      <p>
        서버 컴퓨터의 절대 경로를 입력하세요. 고장에 대비하려면 외장 디스크나
        다른 장치에 동기화되는 폴더를 사용하세요. 연결된 외장 디스크인지 먼저
        확인하세요.
      </p>
      <label className="backup-auto-toggle">
        <input
          type="checkbox"
          checked={autoEnabled}
          disabled={busy || !settings.data}
          onChange={(event) => setAutoDraft(event.target.checked)}
        />
        변경 사항이 있으면 30분마다 자동 백업
      </label>
      <p>
        서버가 실행 중일 때 동작합니다. 브라우저를 닫아도 계속되며, 서버나
        컴퓨터가 꺼져 있는 동안에는 백업하지 않습니다.
      </p>
      <div className="model-actions">
        <button
          disabled={busy || !path.trim() || !settings.data}
          onClick={() => save(false)}
        >
          백업 설정 저장
        </button>
        <button
          className="primary"
          disabled={busy || !path.trim() || !settings.data}
          onClick={() => save(true)}
        >
          {busy ? "처리 중…" : "지금 백업"}
        </button>
      </div>
      {(error || settings.error) && (
        <p className="error" role="alert">
          {error || settings.error?.message}
        </p>
      )}
      {settings.isError && (
        <button onClick={() => settings.refetch()}>설정 다시 불러오기</button>
      )}
      {notice && <p role="status">{notice}</p>}
      {settings.data && (
        <div className="backup-result">
          <strong>
            자동 백업:{" "}
            {settings.data.auto_enabled && settings.data.path ? "켜짐" : "꺼짐"}
          </strong>
          <p>
            마지막 성공:{" "}
            {settings.data.last_success_at
              ? new Date(settings.data.last_success_at).toLocaleString("ko-KR")
              : "아직 없음"}
          </p>
          {settings.data.last_path && <p>{settings.data.last_path}</p>}
          {settings.data.last_checked_at && (
            <p>
              마지막 확인:{" "}
              {new Date(settings.data.last_checked_at).toLocaleString("ko-KR")}
            </p>
          )}
          {settings.data.error && (
            <p role="alert" className="error">
              {settings.data.error}
            </p>
          )}
        </div>
      )}
      {result && (
        <div className="backup-result" role="status">
          <strong>백업 완료 · 책 {result.book_count}권</strong>
          <p>{result.path}</p>
        </div>
      )}
      <details>
        <summary>백업에서 복구하는 방법</summary>
        <p>
          서버를 종료한 뒤, 완성된 백업 폴더 전체를 새 컴퓨터의 로컬 디스크에
          복사하세요. 프로젝트 .env의 DATA_DIR을 복사한 폴더로, DATABASE_URL을
          그 폴더 안의 learning.db로 지정하고 서버를 다시 시작하면 이어서 공부할
          수 있습니다. 경로 예시는 백업 안의 ‘복구 안내.txt’에 있습니다.
        </p>
        <p>
          백업 원본은 따로 보관하세요. API 키와 브라우저별 글자 크기·패널 너비는
          백업에 포함되지 않습니다. 진행 중인 답변은 백업 시점까지 저장된 내용이
          포함됩니다. 자동 백업이 실패하면 기존 백업을 보존하고 다음 주기에
          재시도합니다.
        </p>
      </details>
    </div>
  );
}
