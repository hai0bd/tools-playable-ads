// Kiểm tra project Unity do Build Recover dựng lại (chạy batchmode, KHÔNG chép vào project người dùng):
//   Unity -batchmode -projectPath <project> -executeMethod BuildRecoverVerify.Run -logFile <log> -quit
// Mở từng scene trong Build Settings + mọi prefab, đếm script thiếu / tham chiếu hỏng, render camera chính ra
// <project>/_verify/<scene>.png (canvas Overlay được chuyển tạm sang Screen Space - Camera để lọt vào ảnh).
using System.IO;
using System.Linq;
using System.Text;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

public static class BuildRecoverVerify
{
    public static void Run()
    {
        var sb = new StringBuilder();
        var outDir = Path.Combine(Application.dataPath, "../_verify");
        Directory.CreateDirectory(outDir);
        foreach (var s in EditorBuildSettings.scenes)
        {
            var scene = EditorSceneManager.OpenScene(s.path, OpenSceneMode.Single);
            var all = scene.GetRootGameObjects().SelectMany(g => g.GetComponentsInChildren<Transform>(true)).Select(t => t.gameObject).ToArray();
            int missing = all.Sum(g => GameObjectUtility.GetMonoBehavioursWithMissingScriptCount(g));
            sb.AppendLine($"SCENE {s.path}: {all.Length} gameObjects, {missing} missing scripts");
            foreach (var g in all.Where(g => GameObjectUtility.GetMonoBehavioursWithMissingScriptCount(g) > 0).Take(10))
                sb.AppendLine("  missing script on " + PathOf(g.transform));
            Render(scene.name, outDir, sb);
        }
        foreach (var guid in AssetDatabase.FindAssets("t:Prefab", new[] { "Assets" }))
        {
            var path = AssetDatabase.GUIDToAssetPath(guid);
            var go = AssetDatabase.LoadAssetAtPath<GameObject>(path);
            if (go == null) { sb.AppendLine("PREFAB LOAD FAILED " + path); continue; }
            int missing = go.GetComponentsInChildren<Transform>(true).Sum(t => GameObjectUtility.GetMonoBehavioursWithMissingScriptCount(t.gameObject));
            if (missing > 0) sb.AppendLine($"PREFAB {path}: {missing} missing scripts");
        }
        File.WriteAllText(Path.Combine(outDir, "report.txt"), sb.ToString());
        Debug.Log("BuildRecoverVerify\n" + sb);
    }

    static string PathOf(Transform t) => t.parent == null ? t.name : PathOf(t.parent) + "/" + t.name;

    static void Render(string name, string outDir, StringBuilder sb)
    {
        var cams = Object.FindObjectsOfType<Camera>().Where(c => c.enabled && c.gameObject.activeInHierarchy).OrderBy(c => c.depth).ToArray();
        if (cams.Length == 0) { sb.AppendLine("  (không có camera)"); return; }
        const int W = 540, H = 960;
        var rt = new RenderTexture(W, H, 24, RenderTextureFormat.ARGB32);
        foreach (var canvas in Object.FindObjectsOfType<Canvas>())
        {
            if (!canvas.isRootCanvas || canvas.renderMode == RenderMode.WorldSpace) continue;
            // CanvasScaler reads the (batchmode) screen size, not our render texture: apply its formula by hand
            var scaler = canvas.GetComponent<UnityEngine.UI.CanvasScaler>();
            float scale = 1f;
            if (scaler != null && scaler.uiScaleMode == UnityEngine.UI.CanvasScaler.ScaleMode.ScaleWithScreenSize)
            {
                var r = scaler.referenceResolution;
                float lw = Mathf.Log(W / r.x, 2), lh = Mathf.Log(H / r.y, 2);
                scale = Mathf.Pow(2, Mathf.Lerp(lw, lh, scaler.matchWidthOrHeight));
                scaler.enabled = false;
            }
            canvas.renderMode = RenderMode.ScreenSpaceCamera;
            canvas.worldCamera = cams.Last();
            canvas.planeDistance = Mathf.Min(1f, cams.Last().farClipPlane * 0.5f) + cams.Last().nearClipPlane;
            canvas.scaleFactor = scale;
        }
        Canvas.ForceUpdateCanvases();
        foreach (var cam in cams)
        {
            var old = cam.targetTexture;
            cam.aspect = (float)W / H;
            cam.targetTexture = rt;
            cam.Render();
            cam.targetTexture = old;
        }
        RenderTexture.active = rt;
        var tex = new Texture2D(W, H, TextureFormat.RGB24, false);
        tex.ReadPixels(new Rect(0, 0, W, H), 0, 0);
        tex.Apply();
        RenderTexture.active = null;
        File.WriteAllBytes(Path.Combine(outDir, name + ".png"), tex.EncodeToPNG());
        sb.AppendLine($"  render: {cams.Length} camera → _verify/{name}.png");
    }
}
