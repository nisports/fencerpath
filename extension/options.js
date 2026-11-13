const $ = id => document.getElementById(id);

async function render() {
  const { config = {}, status, lastSuccess } = await chrome.storage.local.get(["config", "status", "lastSuccess"]);
  $("endpoint").value = config.endpoint || "https://fencerpath.com";
  $("secret").value = config.secret || "";
  const el = $("status");
  el.className = status?.state || "";
  el.textContent =
    (status ? `${status.message}\n(${new Date(status.at).toLocaleString("sv-SE")})` : "Ingen synk ännu.") +
    (lastSuccess ? `\nSenast lyckad: ${new Date(lastSuccess).toLocaleString("sv-SE")}` : "");
}

$("save").onclick = async () => {
  await chrome.storage.local.set({ config: { endpoint: $("endpoint").value.trim(), secret: $("secret").value.trim() } });
  $("status").textContent = "Sparat.";
};

$("sync").onclick = async () => {
  $("status").className = "";
  $("status").textContent = "Synkar… (ca 1 minut)";
  await chrome.runtime.sendMessage({ type: "syncNow" });
  render();
};

chrome.storage.onChanged.addListener(render);
render();
