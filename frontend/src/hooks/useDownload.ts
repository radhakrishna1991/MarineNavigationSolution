/**
 * Authenticated file download.
 *
 * A plain anchor cannot carry an Authorization header, so exports are fetched
 * as a blob and handed to the browser. The alternative - putting the token in
 * the query string - would leak it into browser history and any proxy log.
 */

import { useCallback, useState } from 'react';
import { useAppDispatch, useAppSelector } from '../store';
import { toastAdded } from '../store/uiSlice';
import { API_BASE } from '../api/api';

export function useDownload() {
  const token = useAppSelector((s) => s.auth.token);
  const dispatch = useAppDispatch();
  const [busy, setBusy] = useState(false);

  const download = useCallback(
    async (dataset: string, format: string, runId?: string | null, filename?: string) => {
      setBusy(true);
      try {
        const params = new URLSearchParams({ dataset, format });
        if (runId) params.set('runId', runId);
        const response = await fetch(`${API_BASE}/api/export?${params.toString()}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {}
        });
        if (!response.ok) {
          let message = `Export failed (${response.status}).`;
          try {
            const body = await response.json();
            message = body.message ?? message;
          } catch {
            // Non-JSON error body; the status is enough.
          }
          throw new Error(message);
        }

        // An HTML report is more useful opened in a tab, where the browser's
        // own print-to-PDF produces the deliverable.
        if (format === 'html') {
          const html = await response.text();
          const win = window.open('', '_blank', 'noopener,noreferrer');
          if (win) {
            win.document.write(html);
            win.document.close();
          } else {
            dispatch(toastAdded('warning', 'Pop-up blocked', 'Allow pop-ups to open the printable report.'));
          }
          return;
        }

        const blob = await response.blob();
        const disposition = response.headers.get('Content-Disposition') ?? '';
        const match = /filename="([^"]+)"/.exec(disposition);
        const name = filename ?? match?.[1] ?? `${dataset}.${format}`;

        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = name;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(url);

        dispatch(toastAdded('success', 'Export ready', name));
      } catch (err) {
        dispatch(toastAdded('error', 'Export failed', (err as Error).message));
      } finally {
        setBusy(false);
      }
    },
    [token, dispatch]
  );

  return { download, busy };
}
