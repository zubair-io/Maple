namespace Maple.UI
{
    /// <summary>Plain, WinUI-free decision logic behind
    /// <c>MuiPageSettings</c>'s cross-organism wiring (#3012) — the
    /// invite-a-user form (feeding the User Management organism) only
    /// enables its submit action once the typed payload looks like an
    /// email address, the same shallow-but-real gate the Sign In page's
    /// own field validation uses.</summary>
    public static class MuiSettingsPageReducer
    {
        public static bool IsValidInvite(string email)
        {
            if (string.IsNullOrWhiteSpace(email)) return false;
            var at = email.IndexOf('@');
            if (at <= 0 || at >= email.Length - 1) return false;
            var domain = email[(at + 1)..];
            return domain.Contains('.') && !domain.StartsWith('.') && !domain.EndsWith('.');
        }
    }
}
