// ---------------------------------------------------------------------------
// Elements
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);

const statusEl        = $("status");
const addressesEl     = $("addresses");
const backendUrlInput = $("backendUrl");
const googleClientIdInput = $("googleClientId");
const initGoogleBtn   = $("initGoogleBtn");
const startBtn        = $("startBtn");
const googleBtnWrap   = $("googleBtnWrap");
const copyAllBtn      = $("copyAllBtn");
const resetBtn        = $("resetBtn");
const devCreateBtn    = $("devCreateBtn");
const connDot         = $("connDot");
const connLabel       = $("connLabel");

let latestAddresses = {};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function setStatus(msg, data) {
  statusEl.textContent = data ? `${msg}\n${JSON.stringify(data, null, 2)}` : msg;
}

function getBackendBase() {
  return backendUrlInput.value.trim().replace(/\/$/, "");
}

function renderAddresses(addresses) {
  latestAddresses = addresses || {};
  addressesEl.innerHTML = "";
  const entries = Object.entries(latestAddresses);
  if (!entries.length) {
    addressesEl.innerHTML = '<div class="hint">No addresses yet.</div>';
    return;
  }
  entries.forEach(([chain, value]) => {
    const div = document.createElement("div");
    div.className = "address-item";
    div.innerHTML = `<strong>${chain}</strong><div class="addr-value">${value}</div>`;
    addressesEl.appendChild(div);
  });
}

// ---------------------------------------------------------------------------
// Connection check
// ---------------------------------------------------------------------------
async function checkConnection() {
  try {
    const res = await fetch(`${getBackendBase()}/healthz`);
    if (!res.ok) throw new Error();
    const data = await res.json();
    connDot.className = "dot dot-ok";
    connLabel.textContent = `Connected — ${data.ikaNetwork || "unknown"} · ${data.queueMode || "?"}`;
  } catch {
    connDot.className = "dot dot-error";
    connLabel.textContent = "Offline";
  }
}

// Re-check when backend URL changes
backendUrlInput.addEventListener("change", checkConnection);
checkConnection();

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------
async function requestContinue(idToken) {
  const res = await fetch(`${getBackendBase()}/v1/auth/google/continue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idToken, idempotencyKey: crypto.randomUUID() }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json?.error?.message || "Continue endpoint failed");
  return json.data;
}

async function fetchWithSession(path, token) {
  const res = await fetch(`${getBackendBase()}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json?.error?.message || `Request failed: ${path}`);
  return json.data;
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------
async function pollUntilReady(sessionToken) {
  const maxAttempts = 60;
  for (let i = 1; i <= maxAttempts; i++) {
    const prov = await fetchWithSession("/v1/wallets/me/provisioning-status", sessionToken);
    setStatus(`Polling ${i}/${maxAttempts}`, prov);

    if (prov?.status === "completed") {
      const wallet = await fetchWithSession("/v1/wallets/me", sessionToken);
      const addrs  = await fetchWithSession("/v1/wallets/me/addresses", sessionToken);
      renderAddresses(addrs);
      setStatus("✅ Provisioning complete", { wallet, addresses: addrs });
      return;
    }

    if (prov?.status === "failed" || prov?.status === "partial") {
      throw new Error(`Provisioning ${prov.status}`);
    }

    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("Timeout waiting for provisioning");
}

// ---------------------------------------------------------------------------
// Google auth flow
// ---------------------------------------------------------------------------
async function onGoogleIdTokenReceived(idToken) {
  try {
    setStatus("Calling /v1/auth/google/continue …");
    const result = await requestContinue(idToken);
    setStatus("Continue response", result);
    renderAddresses(result.addresses);
    if (!result.sessionToken) throw new Error("No sessionToken returned");
    await pollUntilReady(result.sessionToken);
  } catch (err) {
    setStatus("❌ " + (err instanceof Error ? err.message : String(err)));
  }
}

function initGoogle() {
  const clientId = googleClientIdInput.value.trim();
  if (!clientId) { setStatus("Enter a Google Client ID first."); return; }
  if (!window.google?.accounts?.id) { setStatus("Google script not loaded yet — wait a moment."); return; }

  window.google.accounts.id.initialize({
    client_id: clientId,
    callback: (resp) => resp?.credential && onGoogleIdTokenReceived(resp.credential),
    auto_select: false,
    ux_mode: "popup",
  });

  googleBtnWrap.innerHTML = "";
  window.google.accounts.id.renderButton(googleBtnWrap, {
    theme: "outline", size: "large", text: "continue_with", shape: "rectangular",
  });

  setStatus("Google initialized — click the Google button.");
}

// ---------------------------------------------------------------------------
// Dev bypass
// ---------------------------------------------------------------------------
async function devCreateWallet() {
  try {
    devCreateBtn.disabled = true;
    setStatus("⏳ POST /v1/dev/create-wallet …");

    const res = await fetch(`${getBackendBase()}/v1/dev/create-wallet`, { method: "POST" });
    const json = await res.json();
    if (!res.ok) throw new Error(json?.error?.message || "Dev create-wallet failed");

    const result = json.data;
    setStatus("Wallet created — polling provisioning", result);
    renderAddresses(result.addresses);
    if (!result.sessionToken) throw new Error("No sessionToken returned");
    await pollUntilReady(result.sessionToken);
  } catch (err) {
    setStatus("❌ " + (err instanceof Error ? err.message : String(err)));
  } finally {
    devCreateBtn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Copy & reset
// ---------------------------------------------------------------------------
async function copyAllAddresses() {
  const entries = Object.entries(latestAddresses);
  if (!entries.length) { setStatus("No addresses to copy."); return; }
  const text = entries.map(([c, a]) => `${c}: ${a}`).join("\n");
  try {
    await navigator.clipboard.writeText(text);
    setStatus("Copied ✅");
  } catch (e) {
    setStatus("Copy failed — " + (e instanceof Error ? e.message : String(e)));
  }
}

function resetSession() {
  latestAddresses = {};
  setStatus("Idle — choose an auth method above to start.");
  renderAddresses({});
}

// ---------------------------------------------------------------------------
// Bind
// ---------------------------------------------------------------------------
initGoogleBtn.addEventListener("click", initGoogle);
startBtn.addEventListener("click", () => window.google?.accounts?.id?.prompt());
copyAllBtn.addEventListener("click", copyAllAddresses);
resetBtn.addEventListener("click", resetSession);
devCreateBtn.addEventListener("click", devCreateWallet);

setStatus("Idle — choose an auth method above to start.");
renderAddresses({});
