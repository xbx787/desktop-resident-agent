import { useState } from 'react';
import { toolArgumentDetails } from './tool-arguments';

/** A second, optional disclosure inside an expanded tool card. Formatting and
 * mounting the full input wait until its first open, so a long command or
 * JSON payload does not enlarge or slow down the ordinary result view. */
export function ToolInputDetails({ input }: { input: string | undefined }) {
  const [openedOnce, setOpenedOnce] = useState(false);
  if (!input?.trim()) return null;

  return <details className="panel-tool-input-details" onToggle={(event) => {
    if (event.currentTarget.open) setOpenedOnce(true);
  }}>
    <summary title="查看输入参数">输入参数</summary>
    {openedOnce && <pre className="panel-tool-input-code" aria-label="输入参数内容" tabIndex={0}>{toolArgumentDetails(input)}</pre>}
  </details>;
}
