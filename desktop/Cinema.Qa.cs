using System;
using System.IO;
using System.Threading;
using System.Windows.Forms;

internal sealed partial class CinemaWindow
{
    private string fixtureDirectory;
    private System.Windows.Forms.Timer fixtureTimer;

    private CinemaWindow(string url, string directory, EventWaitHandle activation)
        : this(directory, activation)
    {
        origin = url;
        fixtureDirectory = directory;
        Text = "Cinema Playback QA";
        FormClosed += (sender, args) => { if (fixtureTimer != null) fixtureTimer.Dispose(); };
    }

    private static bool RunFixture(string[] args)
    {
        if (args.Length == 0 || args[0] != "--fixture") return false;
        Uri url;
        if (args.Length != 3 || !Uri.TryCreate(args[1], UriKind.Absolute, out url) ||
            url.Scheme != "http" || url.Host != "127.0.0.1" || url.Port < 1024 ||
            url.Port == CinemaPort || url.Port == InstalledCinemaPort || url.Port == SceneCompanionPort ||
            url.PathAndQuery != "/" || url.UserInfo.Length != 0 ||
            !Directory.Exists(args[2]))
            throw new ArgumentException("QA needs an isolated loopback service and a fixture directory.");
        using (var activation = new EventWaitHandle(false, EventResetMode.AutoReset))
        using (var window = new CinemaWindow(url.GetLeftPart(UriPartial.Authority), args[2], activation))
            Application.Run(window);
        return true;
    }

    private void StartFixtureObservation()
    {
        if (fixtureTimer != null) return;
        var destination = Path.Combine(fixtureDirectory, "webview-playback.ndjson");
        fixtureTimer = new System.Windows.Forms.Timer { Interval = 400 };
        fixtureTimer.Tick += async (sender, args) => {
            fixtureTimer.Stop();
            try
            {
                var result = await view.CoreWebView2.ExecuteScriptAsync(@"(() => {
                    const v = document.querySelector('#video');
                    if (!v) return null;
                    const q = v.getVideoPlaybackQuality();
                    return {
                        at: Date.now(), time: v.currentTime, ready: v.readyState,
                        paused: v.paused, width: v.videoWidth, frames: q.totalVideoFrames,
                        dropped: q.droppedVideoFrames, error: v.error?.code ?? null,
                        errorMessage: v.error?.message ?? null,
                        buffered: Array.from({length:v.buffered.length}, (_,i)=>[v.buffered.start(i),v.buffered.end(i)]),
                        status: document.querySelector('#playback-status')?.textContent,
                        subtitle: document.querySelector('#subtitle-status')?.textContent,
                        tracks: Array.from(v.textTracks, t=>({mode:t.mode, count:t.cues?.length??0,
                            active:Array.from(t.activeCues||[],cue=>cue.text)}))
                    };
                })()");
                File.AppendAllText(destination, result + Environment.NewLine);
            }
            catch (Exception error)
            {
                if (!IsDisposed) File.AppendAllText(Path.Combine(fixtureDirectory, "webview-error.log"), error.Message + Environment.NewLine);
            }
            finally
            {
                if (!IsDisposed) fixtureTimer.Start();
            }
        };
        fixtureTimer.Start();
    }
}
