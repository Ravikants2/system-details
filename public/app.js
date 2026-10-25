const elements = {
  browserDetail: document.querySelector("#browser-detail"),
  browserStat: document.querySelector("#browser-stat"),
  checkbox: document.querySelector("#consent-checkbox"),
  deviceDetail: document.querySelector("#device-detail"),
  deviceStat: document.querySelector("#device-stat"),
  osDetail: document.querySelector("#os-detail"),
  osStat: document.querySelector("#os-stat"),
  screenDetail: document.querySelector("#screen-detail"),
  screenStat: document.querySelector("#screen-stat"),
  serviceStatus: document.querySelector("#service-status"),
  serviceStatusDot: document.querySelector("#service-status-dot"),
  shareButton: document.querySelector("#share-button"),
  submitMessage: document.querySelector("#submit-message"),
  todayDate: document.querySelector("#today-date"),
  collectionStatus: document.querySelector("#collection-status"),
  consentCopy: document.querySelector("#consent-copy"),
};

let storageMode = "checking";

function detectBrowser(userAgent) {
  if (/Edg\//.test(userAgent)) return "Edge";
  if (/OPR\/|Opera/.test(userAgent)) return "Opera";
  if (/Firefox\//.test(userAgent)) return "Firefox";
  if (/Chrome\//.test(userAgent)) return "Chrome";
  if (/Safari\//.test(userAgent)) return "Safari";
  return "Other";
}

function detectOperatingSystem(userAgent) {
  if (/CrOS/.test(userAgent)) return "ChromeOS";
  if (/Android/.test(userAgent)) return "Android";
  if (/iPhone|iPad|iPod/.test(userAgent)) return "iOS";
  if (/Windows NT/.test(userAgent)) return "Windows";
  if (/Mac OS X|Macintosh/.test(userAgent)) return "macOS";
  if (/Linux/.test(userAgent)) return "Linux";
  return "Other";
}

function detectDeviceType(userAgent) {
  if (/iPad|Tablet|PlayBook|Silk/.test(userAgent)) return "Tablet";
  if (/Mobile|iPhone|iPod|Android/.test(userAgent)) return "Mobile";
  return "Desktop";
}

function detectSystem() {
  const userAgent = navigator.userAgent;
  return {
    browser: detectBrowser(userAgent),
    operatingSystem: detectOperatingSystem(userAgent),
    deviceType: detectDeviceType(userAgent),
    displayResolution: `${screen.width} x ${screen.height}`,
  };
}

function setText(element, value) {
  element.textContent = value;
}

function renderDevice(system) {
  setText(elements.browserDetail, system.browser);
  setText(elements.browserStat, system.browser);
  setText(elements.osDetail, system.operatingSystem);
  setText(elements.osStat, system.operatingSystem);
  setText(elements.deviceDetail, system.deviceType);
  setText(elements.deviceStat, system.deviceType);
  setText(elements.screenDetail, `${system.displayResolution} px`);
  setText(elements.screenStat, `${system.displayResolution} px display`);
  elements.todayDate.textContent = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date());
}

async function loadServiceStatus() {
  try {
    const response = await fetch("/api/health", {
      headers: { Accept: "application/json" },
    });
    const status = await response.json();
    if (
      !response.ok ||
      status.storageConfigured !== true ||
      status.storagePrivate !== true
    ) {
      enableLocalExport();
      return;
    }
    storageMode = "api";
    setText(elements.serviceStatus, "All systems operational");
    elements.shareButton.querySelector("span").textContent =
      "Save to private repository";
    elements.consentCopy.firstChild.textContent =
      "I agree to save these limited device details in the private GitHub repository. ";
    elements.shareButton.disabled = !elements.checkbox.checked;
    setSubmissionMessage(
      "Your browser snapshot will be saved only to the verified private repository after confirmation.",
    );
  } catch {
    enableLocalExport();
  }
}

function enableLocalExport() {
  storageMode = "local";
  setText(elements.serviceStatus, "GitHub Pages — local export only");
  elements.serviceStatusDot.classList.add("warning");
  elements.shareButton.querySelector("span").textContent = "Download snapshot";
  elements.shareButton.disabled = !elements.checkbox.checked;
  setSubmissionMessage(
    "This static GitHub Pages site cannot upload data. Confirm to download a JSON copy to your device.",
  );
}

function setSubmissionMessage(message, state = "") {
  elements.submitMessage.textContent = message;
  elements.submitMessage.className = `submit-message ${state}`.trim();
}

function downloadSnapshot(system) {
  const record = {
    schemaVersion: 1,
    collectedAt: new Date().toISOString(),
    ...system,
  };
  const blob = new Blob([`${JSON.stringify(record, null, 2)}\n`], {
    type: "application/json",
  });
  const downloadUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = downloadUrl;
  link.download = `system-snapshot-${new Date().toISOString().replaceAll(":", "-")}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(downloadUrl);

  elements.shareButton.disabled = true;
  elements.shareButton.querySelector("span").textContent = "Snapshot downloaded";
  elements.shareButton.classList.add("shared");
  setText(elements.collectionStatus, "Downloaded locally");
  setSubmissionMessage(
    "Your device snapshot was downloaded to this device. It was not uploaded.",
    "success",
  );
}

async function shareDevice(system) {
  if (storageMode === "local") {
    downloadSnapshot(system);
    return;
  }
  if (storageMode !== "api") {
    return;
  }

  elements.shareButton.disabled = true;
  elements.shareButton.querySelector("span").textContent = "Saving to GitHub…";
  setSubmissionMessage("Saving your snapshot to the private GitHub repository.");
  try {
    const response = await fetch("/api/records", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ consent: true, system }),
    });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error || "Your snapshot could not be saved.");
    }

    setSubmissionMessage("Saved to the private GitHub repository.", "success");
    elements.shareButton.disabled = true;
    elements.shareButton.querySelector("span").textContent = "Snapshot shared";
    elements.shareButton.classList.add("shared");
    if (result.recordUrl) {
      const recordLink = document.createElement("a");
      recordLink.href = result.recordUrl;
      recordLink.target = "_blank";
      recordLink.rel = "noreferrer";
      recordLink.textContent = "Open your private record";
      recordLink.style.marginLeft = "5px";
      elements.submitMessage.append(" ", recordLink);
    }
  } catch (error) {
    elements.shareButton.disabled = !elements.checkbox.checked;
    elements.shareButton.querySelector("span").textContent =
      "Share my device snapshot";
    setSubmissionMessage(error.message, "error");
  }
}

const system = detectSystem();
renderDevice(system);
elements.checkbox.addEventListener("change", () => {
  elements.shareButton.disabled =
    !elements.checkbox.checked || storageMode === "checking";
});
elements.shareButton.addEventListener("click", () => shareDevice(system));
loadServiceStatus();
