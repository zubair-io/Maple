namespace Maple.UI
{
    /// <summary>Plain, WinUI-free decision logic behind
    /// <c>MuiPageSignIn</c>'s cross-organism wiring (#3012) — the email
    /// and password Form Fields each validate independently (so each can
    /// show its own inline error), and the submit Button only enables
    /// once both are clean.</summary>
    public static class MuiSignInPageReducer
    {
        public static string? EmailError(string email)
        {
            if (string.IsNullOrWhiteSpace(email)) return "Email is required.";
            var at = email.IndexOf('@');
            return at > 0 && at < email.Length - 1 && email[(at + 1)..].Contains('.')
                ? null
                : "Enter a valid email address.";
        }

        public static string? PasswordError(string password)
        {
            if (string.IsNullOrEmpty(password)) return "Password is required.";
            return password.Length < 8 ? "Must be at least 8 characters." : null;
        }

        public static bool CanSubmit(string email, string password) =>
            EmailError(email) is null && PasswordError(password) is null;
    }
}
