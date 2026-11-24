import React, { useRef, useState } from 'react';
import { ChevronDown, Copy, Plug, Terminal } from 'lucide-react';
import { copyText } from './clipboard.ts';
import { useI18n, withMarkup } from './i18n.tsx';

function Command({ label, text, interactive }: { label: string; text: string; interactive: boolean }) {
  const { t } = useI18n();
  const content = useRef<HTMLElement>(null);
  const [status, setStatus] = useState<'copied' | 'copyManually'>();

  async function copy() {
    if (await copyText(text)) {
      setStatus('copied');
    } else {
      if (content.current) window.getSelection()?.selectAllChildren(content.current);
      setStatus('copyManually');
    }
  }

  return <figure className="agent-command">
    <figcaption>
      <span>{label}</span>
      {interactive && <div className="agent-command-actions">
        <span role="status">{status && t(status)}</span>
        <button type="button" className="button quiet" aria-label={t('copyCommand', { label })} onClick={() => void copy()}>
          <Copy size={14} aria-hidden="true" /> {t('copy')}
        </button>
      </div>}
    </figcaption>
    <pre dir="ltr" tabIndex={0} aria-label={t('commandLabel', { label })}><code ref={content}>{text}</code></pre>
  </figure>;
}

export function AgentGuide({ origin, interactive }: { origin?: string; interactive: boolean }): React.JSX.Element {
  const { t } = useI18n();
  const site = origin ?? 'https://files.example.com';
  const server = "--server '" + site.replaceAll("'", "'\\''") + "'";
  const inviteExample = t('cliInviteExample');
  const send = [
    `npm run cli -- peers --invite "${inviteExample}"`,
    `npm run cli -- send --invite "${inviteExample}" --to "iPhone" ./report.pdf`,
  ].join('\n');
  const codex = [
    'mkdir -p inbox outbox',
    'codex mcp add file-room -- \\',
    '  "$(command -v node)" \\',
    '  "$PWD/dist-agent/agent/cli.js" mcp \\',
    '  ' + server + ' \\',
    '  --inbox "$PWD/inbox" \\',
    '  --send-dir "$PWD/outbox"',
  ].join('\n');

  return <section id="agent-guide" className="agent-guide" aria-labelledby="agent-guide-title">
    <h2 id="agent-guide-title">{t('agentGuide')}</h2>
    <p>{t('agentIntro')}</p>

    <div className="agent-guide-flows">
      <article>
        <h3>{t('phoneToAgent')}</h3>
        <p className="agent-example">{t('phoneToAgentExample')}</p>
        <p>{t('phoneToAgentSteps')}</p>
      </article>
      <article>
        <h3>{t('agentToPhone')}</h3>
        <p className="agent-example">{t('agentToPhoneExample')}</p>
        <p>{t('agentToPhoneSteps')}</p>
      </article>
    </div>

    <div className="agent-guide-setup">
      <h3>{t('agentSetup')}</h3>
      <p>{t('agentBuildRequirements')}</p>
      <Command label={t('agentBuild')} text={'npm ci\nnpm run build:agent'} interactive={interactive} />
      <p>{withMarkup(t('agentServerAddress'), { allowHttp: <code dir="ltr">--allow-http</code> })}</p>
    </div>

    <details className="agent-guide-detail">
      <summary><Terminal size={20} aria-hidden="true" /><strong>{t('cliQuickStart')}</strong><ChevronDown size={18} aria-hidden="true" /></summary>
      <div className="agent-guide-detail-body">
        <p>{t('cliSendSteps')}</p>
        <Command label={t('cliSend')} text={send} interactive={interactive} />
        <p>{t('cliReceiveSteps')}</p>
        <Command label={t('cliReceive')} text={'npm run cli -- receive ' + server + ' --out ./inbox'} interactive={interactive} />
        <p>{withMarkup(t('cliJson'), { command: <code dir="ltr">npm run --silent cli --</code>, json: <code dir="ltr">--json</code> })}</p>
      </div>
    </details>

    <details className="agent-guide-detail">
      <summary><Plug size={20} aria-hidden="true" /><strong>{t('agentMcp')}</strong><ChevronDown size={18} aria-hidden="true" /></summary>
      <div className="agent-guide-detail-body">
        <p>{withMarkup(t('agentMcpSetup'), { outbox: <code>outbox</code>, inbox: <code>inbox</code> })}</p>
        <Command label={t('agentRegister')} text={codex} interactive={interactive} />
        <p>{t('agentMcpUsage')}</p>
      </div>
    </details>
  </section>;
}
