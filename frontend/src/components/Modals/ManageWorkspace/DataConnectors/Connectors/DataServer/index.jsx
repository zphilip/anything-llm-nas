import React, { useEffect, useState } from "react";
import System from "@/models/system";
import showToast from "@/utils/toast";
import pluralize from "pluralize";
import { Info, Warning } from "@phosphor-icons/react";
import { Tooltip } from "react-tooltip";
import { usePersistedState } from "@/hooks/usePersistedState";

export default function DataServerOptions() {
  // Replace useState with usePersistedState for form fields
  const [nasshare, setNasShare] = usePersistedState("dataserver-nasshare", "");
  const [mountpoint, setMountPoint] = usePersistedState(
    "dataserver-mountpoint",
    ""
  );
  const [username, setUserName] = usePersistedState("dataserver-username", "");
  const [password, setPassword] = usePersistedState("dataserver-password", "");
  const [ignores, setIgnores] = usePersistedState("dataserver-ignores", []);
  const [settings, setSettings] = useState({
    nasshare: nasshare,
    username: username,
    password: password,
    ignores: ignores,
  });

  // Other state that doesn't need persistence
  const [loading, setLoading] = useState(false);
  const [processId, setProcessId] = usePersistedState(
    "dataserver-processId",
    null
  );
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState(null);
  const [canceling, setCanceling] = useState(false);

  useEffect(() => {
    // check processId and progress is empty or not
    if (processId) {
      pollProgress(processId);
    }
  }, [processId]);

  // Update the pollProgress function
  const pollProgress = (processId) => {
    const interval = setInterval(async () => {
      try {
        setProgress("0");
        const { data } = await System.dataConnectors.dataserver.checkStatus({
          processId: processId,
        });

        // Update the progress check in pollProgress function
        if (
          data &&
          (typeof data.progress === "number" ||
            typeof data.progress === "string")
        ) {
          // Convert progress to number, default to 0 if conversion fails
          const progressString = String(data.progress) || "0";
          setProcessing(true);
          setLoading(true);
          setProgress(progressString);
        }

        // Check status from data object
        if (
          data &&
          (data?.status === "completed" ||
            data?.status === "failed" ||
            canceling)
        ) {
          clearInterval(interval);
          setProcessing(false);
          setLoading(false);
          setProgress(null);
        }
      } catch (error) {
        console.error("Error fetching progress:", error);
        clearInterval(interval);
        setProcessing(false);
        setLoading(false);
        setProgress(null);
      }
    }, 10000);

    // Store interval ID for cleanup
    return interval;
  };

  const handleCancel = async () => {
    try {
      setCanceling(true);
      showToast("Cancelling process - please wait...", "info", {
        clear: true,
        autoClose: false,
      });

      if (!processId) {
        throw new Error("No process ID available to cancel");
      }

      const { data, error } = await System.dataConnectors.dataserver.cancel({
        processId,
      });

      if (error) {
        throw new Error(error);
      }

      setProcessing(false);
      setProgress(null);
      showToast("Process cancelled successfully", "success", { clear: true });
    } catch (error) {
      console.error("Cancel error:", error);
      showToast(error.message || "Failed to cancel process", "error", {
        clear: true,
      });
    } finally {
      setCanceling(false);
    }
  };

  // Add this function to clear form data
  const clearPersistedData = () => {
    localStorage.removeItem("dataserver-nasshare");
    localStorage.removeItem("dataserver-username");
    localStorage.removeItem("dataserver-password");
    localStorage.removeItem("dataserver-ignores");

    // Reset state
    setNasShare("");
    setUserName("");
    setPassword("");
    setIgnores([]);
  };

  // Update handleSubmit to clear data on successful submission
  const handleSubmit = async (e) => {
    e.preventDefault();
    const form = new FormData(e.target);

    try {
      setLoading(true);
      showToast(
        "Fetching all files from NAS - this may take a while.",
        "info",
        { clear: true, autoClose: false }
      );
      const { data, error } = await System.dataConnectors.dataserver.connect({
        nasshare: form.get("nasshare"),
        username: form.get("username"),
        password: form.get("password"),
        ignorePaths: ignores,
      });

      if (!!error) {
        showToast(error, "error", { clear: true });
        setLoading(false);
        return;
      }

      setProcessId(data.processId); // Store the processId for polling
      setProcessing(true); // Set the state to processing

      showToast(
        `Files are being collected from ${form.get("nasshare")}. This process will continue in the background.`,
        "success",
        { clear: true }
      );
      // Start polling the progress
      pollProgress(data.processId);

      if (data.success) {
        clearPersistedData(); // Clear persisted data on success
      }

      e.target.reset();
      setLoading(false);
      return;
    } catch (e) {
      console.error(e);
      showToast(e.message, "error", { clear: true });
      setLoading(false);
    }
  };

  // Handle mount request through backend API
  const handleMount = async (e) => {
    e.preventDefault();

    try {
      setLoading(true);
      showToast("Mounting SMB share - please wait...", "info", {
        clear: true,
        autoClose: false,
      });

      if (!nasshare || !username || !password || !mountpoint) {
        throw new Error("Please fill in all required fields");
      }

      // Call backend API instead of direct exec
      const { data, error } = await System.dataConnectors.dataserver.mount({
        nasshare,
        username,
        password,
        mountpoint,
        ignores,
      });

      if (!!error) {
        showToast(error, "error", { clear: true });
        setLoading(false);
        return;
      }

      setProcessId(data.processId); // Store the processId for polling
      setProcessing(true); // Set the state to processing

      showToast(
        "SMB share mounted successfully, processing files...",
        "success",
        { clear: true }
      );

      // Start polling the progress
      pollProgress(data.processId);
      return;
    } catch (error) {
      console.error("Mount error:", error);
      showToast(error.message || "Failed to mount SMB share", "error", {
        clear: true,
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex w-full">
      <div className="flex flex-col w-full px-1 md:pb-6 pb-16">
        <form className="w-full" onSubmit={handleSubmit}>
          <div className="w-full flex flex-col py-2">
            <div className="w-full flex flex-col gap-4">
              <div className="flex flex-col pr-10">
                <div className="flex flex-col gap-y-1 mb-4">
                  <label className="text-white text-sm font-bold">
                    NAS Share Path or Network Path
                  </label>
                  <p className="text-xs font-normal text-white/50">
                    Network path of the NAS share you wish to collect files
                    from.
                  </p>
                </div>
                <input
                  type="text"
                  name="nasshare"
                  value={nasshare}
                  className="border-none bg-theme-settings-input-bg text-white placeholder:text-theme-settings-input-placeholder text-sm rounded-lg focus:outline-primary-button active:outline-primary-button outline-none block w-full p-2.5"
                  placeholder="\\192.168.1.100\shared\documents"
                  required={true}
                  autoComplete="off"
                  onChange={(e) => setNasShare(e.target.value)}
                  onBlur={() => setSettings({ ...settings, nasshare })}
                  spellCheck={false}
                />
              </div>
              <div className="flex flex-col pr-10">
                <div className="flex flex-col gap-y-1 mb-4">
                  <label className="text-white font-bold text-sm flex gap-x-2 items-center">
                    <p className="font-bold text-white">Username</p>
                  </label>
                  <p className="text-xs font-normal text-white/50">
                    NAS login username (required for authentication).
                  </p>
                </div>
                <input
                  type="text"
                  name="username"
                  value={username}
                  className="border-none bg-theme-settings-input-bg text-white placeholder:text-theme-settings-input-placeholder text-sm rounded-lg focus:outline-primary-button active:outline-primary-button outline-none block w-full p-2.5"
                  placeholder="Your Username"
                  required={false}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => setUserName(e.target.value)}
                  onBlur={() => setSettings({ ...settings, username })}
                />
              </div>
              <div className="flex flex-col pr-10">
                <div className="flex flex-col gap-y-1 mb-4">
                  <label className="text-white font-bold text-sm flex gap-x-2 items-center">
                    <p className="font-bold text-white">Password</p>
                  </label>
                  <p className="text-xs font-normal text-white/50">
                    NAS login password (kept secure on server).
                  </p>
                </div>
                <input
                  type="password"
                  name="password"
                  value={password}
                  className="border-none bg-theme-settings-input-bg text-white placeholder:text-theme-settings-input-placeholder text-sm rounded-lg focus:outline-primary-button active:outline-primary-button outline-none block w-full p-2.5"
                  placeholder="Password"
                  required={false}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => setPassword(e.target.value)}
                  onBlur={() => setSettings({ ...settings, password })}
                />
              </div>
            </div>
            <div className="flex flex-col w-full py-4 pr-10">
              <div className="flex flex-col gap-y-1 mb-4">
                <label className="text-white text-sm flex gap-x-2 items-center">
                  <p className="text-white text-sm font-bold">File Ignores</p>
                </label>
                <p className="text-xs font-normal text-white/50">
                  List in .gitignore format to ignore specific files during
                  collection. Press enter after each entry.
                </p>
              </div>
              <input
                type="text"
                name="ignores"
                value={ignores.join(", ")}
                onChange={(e) => {
                  const tags = e.target.value
                    .split(",")
                    .map((tag) => tag.trim())
                    .filter(Boolean);
                  setIgnores(tags);
                  setSettings((prev) => ({ ...prev, ignores: tags }));
                }}
                placeholder="!*.js, images/*, .DS_Store, bin/*"
                className="border-none bg-theme-settings-input-bg text-white placeholder:text-theme-settings-input-placeholder text-sm rounded-lg focus:outline-primary-button active:outline-primary-button outline-none block w-full p-2.5"
              />
            </div>
          </div>
          <div className="flex flex-col gap-y-2 w-full pr-10">
            <NASAlert />
            <button
              type="submit"
              disabled={loading || processing}
              className="mt-2 w-full justify-center border border-slate-200 px-4 py-2 rounded-lg text-dark-text text-sm font-bold items-center flex gap-x-2 bg-slate-200 hover:bg-slate-300 hover:text-slate-800 disabled:bg-slate-300 disabled:cursor-not-allowed"
            >
              {loading
                ? "Collecting files..."
                : processing
                  ? "Processing..."
                  : "Connect and Process"}
            </button>
          </div>
          <div className="flex flex-col gap-y-2 w-full pr-10 mt-4">
            <div className="flex flex-col pr-10">
              <div className="flex flex-col gap-y-1 mb-4">
                <label className="text-white text-sm font-bold">
                  Local Mount Point (Optional)
                </label>
                <p className="text-xs font-normal text-white/50">
                  Local directory path where the NAS share will be mounted
                  (advanced users only).
                </p>
              </div>
              <input
                type="text"
                name="mountpoint"
                value={mountpoint}
                className="border-none bg-theme-settings-input-bg text-white placeholder:text-theme-settings-input-placeholder text-sm rounded-lg focus:outline-primary-button active:outline-primary-button outline-none block w-full p-2.5"
                placeholder="/mnt/nas"
                required={false}
                autoComplete="off"
                onChange={(e) => setMountPoint(e.target.value)}
                onBlur={() => setSettings({ ...settings, mountpoint })}
                spellCheck={false}
              />
            </div>
            <button
              type="button"
              onClick={(e) => {
                handleMount(e);
              }}
              disabled={
                loading ||
                processing ||
                !nasshare ||
                !username ||
                !password ||
                !mountpoint
              }
              className="mt-2 w-full justify-center border border-slate-200 px-4 py-2 rounded-lg text-dark-text text-sm font-bold items-center flex gap-x-2 bg-slate-200 hover:bg-slate-300 hover:text-slate-800 disabled:bg-slate-300 disabled:cursor-not-allowed"
            >
              {loading
                ? "Mounting..."
                : processing
                  ? "Processing..."
                  : "Mount and Process"}
            </button>
          </div>
          <div className="flex flex-col gap-y-2 w-full pr-10 mt-4">
            {processing && (
              <button
                type="button"
                onClick={handleCancel}
                disabled={canceling}
                className="mt-2 w-full justify-center border border-red-500 px-4 py-2 rounded-lg text-red-600 text-sm font-bold items-center flex gap-x-2 bg-red-50 hover:bg-red-100 disabled:bg-slate-300 disabled:cursor-not-allowed"
              >
                {canceling ? "Cancelling..." : "Cancel Process"}
              </button>
            )}
            {progress !== null && processing && (
              <ProcessingProgress progress={progress} processing={processing} />
            )}
            {(loading || processing) && (
              <p className="text-xs text-white/50 text-center">
                Once complete, all files will be available for embedding into
                workspaces in the document picker.
              </p>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}

function NASAlert() {
  return (
    <div className="flex flex-col md:flex-row md:items-center gap-x-2 text-white mb-4 bg-blue-800/30 w-fit rounded-lg px-4 py-2">
      <div className="gap-x-2 flex items-center">
        <Info className="shrink-0" size={25} />
        <p className="text-sm">
          It may take a while to collect all files from the NAS share depending
          on the size and network speed.
        </p>
      </div>
    </div>
  );
}

// Add this as a separate component
function ProcessingProgress({ progress, processing }) {
  const [elapsedTime, setElapsedTime] = useState(0);

  useEffect(() => {
    let interval;
    if (processing) {
      interval = setInterval(() => {
        setElapsedTime((prev) => prev + 1);
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [processing]);

  const formatTime = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  if (!progress || !processing) return null;

  return (
    <div className="flex flex-col items-center justify-center gap-2 my-4">
      <p className="text-lg font-semibold text-white">
        Processing... {Number(progress).toFixed(2)}% complete
        <span className="animate-pulse ml-1">...</span>
      </p>
      <p className="text-sm text-white/70">
        Time elapsed: {formatTime(elapsedTime)}
      </p>
    </div>
  );
}
