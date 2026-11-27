/**
 * The WebMCP key in the top strip: an LED for whether an in-browser agent can use the editor's tools, and behind it
 * how to turn WebMCP on in this browser and what an agent needs to call the tools. Phones and tablets don't show it
 * (see onMobile).
 */
import { useEditor } from '../store';
import { Icon } from './Icon';

type Browser = 'chrome' | 'brave' | 'edge' | 'other';

/**
 * Phones and tablets. Nothing there calls WebMCP tools yet: Android browsers have no extensions such as the tool
 * inspector, and iOS browsers are all WebKit, which has no WebMCP. The editor still registers its tools when a
 * browser offers the API; it just doesn't advertise them. iPadOS asks for desktop pages as a Mac, hence the touch check.
 */
function onMobile(): boolean {
  const data = (navigator as Navigator & { userAgentData?: { mobile?: boolean; platform?: string } }).userAgentData;
  if (data) return Boolean(data.mobile) || data.platform === 'Android';
  const ua = navigator.userAgent;
  return /Android|iPhone|iPad|iPod|Mobile/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

function whichBrowser(): Browser {
  const nav = navigator as Navigator & { brave?: unknown; userAgentData?: { brands?: { brand: string }[] } };
  if (nav.brave) return 'brave';
  const brands = nav.userAgentData?.brands?.map((b) => b.brand) ?? [];
  if (brands.some((b) => b.includes('Edge')) || /\bEdg\//.test(navigator.userAgent)) return 'edge';
  if (brands.includes('Google Chrome')) return 'chrome';
  return 'other';
}

/**
 * The page's WebMCP origin-trial token, when it is for this origin and still valid: Chrome then offers WebMCP here
 * without a flag. A token is a version byte, a 64-byte signature, a 4-byte length and a JSON payload.
 */
function originTrialUntil(): Date | null {
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[http-equiv="origin-trial"]')) {
    try {
      const bytes = Uint8Array.from(atob(meta.content), (c) => c.charCodeAt(0));
      const length = new DataView(bytes.buffer).getUint32(65);
      const payload = JSON.parse(new TextDecoder().decode(bytes.subarray(69, 69 + length))) as { origin?: string; feature?: string; expiry?: number };
      if (payload.feature !== 'WebMCP' || !payload.origin || !payload.expiry) continue;
      if (new URL(payload.origin).origin !== location.origin || payload.expiry * 1000 < Date.now()) continue;
      return new Date(payload.expiry * 1000);
    } catch {
      // Not a token we can read: ignore it.
    }
  }
  return null;
}

function FlagAddress({ address }: { address: string }) {
  const copy = () =>
    void navigator.clipboard
      ?.writeText(address)
      .then(() => useEditor.getState().toast(`Copied ${address}: paste it into the address bar`))
      .catch(() => useEditor.getState().toast(`Copy failed: type ${address} into the address bar`, 'error'));
  return (
    <span className="flag">
      <code>{address}</code>
      <button type="button" className="tool" aria-label={`Copy ${address}`} title="Copy the address" onClick={copy}>
        <Icon name="copy" size={13} />
      </button>
    </span>
  );
}

function HowToTurnOn({ browser }: { browser: Browser }) {
  const until = originTrialUntil();
  const date = until?.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
  // Brave opens chrome:// addresses as its own brave:// pages, so the two share one row and one address. The origin
  // trial is Chrome's alone: Brave needs the flag even where Chrome doesn't.
  const flag = <FlagAddress address="chrome://flags/#enable-webmcp-testing" />;
  const rows: { ids: Browser[]; name: string; body: React.ReactNode }[] = [
    {
      ids: ['chrome', 'brave'],
      name: 'Chrome, Brave',
      body: until ? (
        <>
          Chrome 149 to 162 turns it on for this site by itself (an origin trial, until {date}). In Brave or an older Chrome, open {flag}, set
          it to Enabled and relaunch.
        </>
      ) : (
        <>Open {flag}, set it to Enabled and relaunch.</>
      ),
    },
    {
      ids: ['edge'],
      name: 'Edge',
      body: (
        <>
          Open <FlagAddress address="edge://flags" />, search for WebMCP, set it to Enabled and relaunch.
        </>
      ),
    },
  ];
  return (
    <>
      <p className="legend">turn it on</p>
      <ul className="howto">
        {rows.map((r) => (
          <li key={r.name} className={r.ids.includes(browser) ? 'is-current' : ''}>
            <b>
              {r.name}
              {r.ids.includes(browser) && <small> · this browser</small>}
            </b>
            <span>{r.body}</span>
          </li>
        ))}
      </ul>
      <p className="popover-text">Then reload this page. Firefox and Safari don't offer WebMCP yet.</p>
    </>
  );
}

export function AgentStatus() {
  return onMobile() ? null : <AgentKey />;
}

function AgentKey() {
  const webmcp = useEditor((s) => s.webmcp);
  const open = useEditor((s) => s.webmcpOpen);
  const live = webmcp !== 'pending' && webmcp.count > 0;
  const shim = live && typeof window.__sfxgenWebMcp !== 'undefined';
  const close = () => useEditor.setState({ webmcpOpen: false });
  const shimUrl = (() => {
    const url = new URL(location.href);
    url.searchParams.set('webmcp', 'shim');
    return url.toString();
  })();
  return (
    <div className="agent-key">
      <button
        type="button"
        className={`pill${live ? ' pill-on' : ' pill-off'}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={
          webmcp === 'pending'
            ? 'Checking for WebMCP…'
            : live
              ? 'Agents in this browser can use the editor'
              : 'Let an agent in this browser use the editor'
        }
        onClick={() => useEditor.setState({ webmcpOpen: !open })}
      >
        <i className="led" />
        WebMCP
      </button>
      {open && (
        <>
          <div className="scrim scrim-clear" onClick={close} />
          <div className="popover popover-end" role="dialog" aria-label="WebMCP">
            <p className="legend">webmcp</p>
            <p className="popover-text">
              WebMCP lets an AI agent in your browser use this editor through tools: find templates, edit a sound, render and measure it, play
              it, balance a set. The tools run here, on your machine.
            </p>
            <p className={`webmcp-state${live ? ' is-on' : ''}`}>
              <i className="led" />
              {webmcp === 'pending'
                ? 'Checking…'
                : shim
                  ? `On, with the built-in stand-in: ${webmcp.count} tools, no agent`
                  : live
                    ? `On: ${webmcp.count} tools on ${webmcp.api}`
                    : 'Not available in this browser yet'}
            </p>
            {!live && <HowToTurnOn browser={whichBrowser()} />}
            <p className="legend">let an agent use it</p>
            <p className="popover-text">
              Something has to call the tools: your browser's assistant if it supports WebMCP, or an extension such as Chrome's Model Context Tool
              Inspector.{' '}
              <a href="https://developer.chrome.com/docs/ai/webmcp" target="_blank" rel="noopener">
                Chrome's WebMCP guide
              </a>{' '}
              links it.
            </p>
            {!live && (
              <p className="popover-text popover-small">
                For developers: <a href={shimUrl}>?webmcp=shim</a> installs a stand-in, so you can call the tools from the console with{' '}
                <code>__sfxgenWebMcp.executeTool('list_templates', {'{'} query: 'door' {'}'})</code>.
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
