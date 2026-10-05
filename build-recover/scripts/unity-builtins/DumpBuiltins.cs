using System.IO;
using System.Text;
using UnityEditor;
using UnityEngine;

public static class DumpBuiltins
{
    static StringBuilder sb = new StringBuilder();

    static void Add(string kind, string name, System.Func<Object> get)
    {
        Object o = null;
        try { o = get(); } catch (System.Exception e) { sb.AppendLine(kind + "\t" + name + "\tERR " + e.Message); return; }
        if (o == null) { sb.AppendLine(kind + "\t" + name + "\tMISSING"); return; }
        string guid; long fid;
        if (AssetDatabase.TryGetGUIDAndLocalFileIdentifier(o, out guid, out fid)) sb.AppendLine(kind + "\t" + name + "\t" + fid + "\t" + guid);
    }

    public static void Run()
    {
        foreach (var info in ShaderUtil.GetAllShaderInfo())
        {
            var s = Shader.Find(info.name);
            if (s == null) continue;
            string guid; long fid;
            if (!AssetDatabase.TryGetGUIDAndLocalFileIdentifier(s, out guid, out fid)) continue;
            if (guid.StartsWith("0000000000000000")) sb.AppendLine("Shader\t" + info.name + "\t" + fid + "\t" + guid);
        }
        foreach (var n in new[] { "Cube.fbx", "Sphere.fbx", "Capsule.fbx", "Cylinder.fbx", "Plane.fbx", "Quad.fbx", "New-Sphere.fbx", "New-Capsule.fbx", "New-Cylinder.fbx", "New-Plane.fbx", "New-Cube.fbx" })
            Add("Mesh", n, () => Resources.GetBuiltinResource<Mesh>(n));
        foreach (var n in new[] { "LegacyRuntime.ttf" })
            Add("Font", n, () => Resources.GetBuiltinResource<Font>(n));
        foreach (var n in new[] { "Default-Material.mat", "Sprites-Default.mat", "Default-Skybox.mat", "Default-Particle.mat", "Default-ParticleSystem.mat", "Default-Line.mat", "Default-Diffuse.mat", "Sprites-Mask.mat", "Default-Terrain-Standard.mat", "Default-UI.mat" })
            Add("Material", n, () => AssetDatabase.GetBuiltinExtraResource<Material>(n));
        foreach (var n in new[] { "UI/Skin/UISprite.psd", "UI/Skin/Background.psd", "UI/Skin/Knob.psd", "UI/Skin/Checkmark.psd", "UI/Skin/InputFieldBackground.psd", "UI/Skin/DropdownArrow.psd", "UI/Skin/UIMask.psd" })
            Add("Sprite", n, () => AssetDatabase.GetBuiltinExtraResource<Sprite>(n));
        foreach (var n in new[] { "Default-Particle.psd", "Default-ParticleSystem.psd" })
            Add("Texture2D", n, () => AssetDatabase.GetBuiltinExtraResource<Texture2D>(n));
        File.WriteAllText(Path.Combine(Application.dataPath, "../builtins.tsv"), sb.ToString());
        Debug.Log("DumpBuiltins done");
    }
}
