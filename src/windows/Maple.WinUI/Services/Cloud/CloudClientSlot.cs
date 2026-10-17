namespace Maple.WinUI.Services.Cloud
{
    public sealed class CloudClientSlot
    {
        public CloudClient? Current { get; private set; }
        public int Generation { get; private set; }

        public void Adopt(CloudClient? next)
        {
            if (ReferenceEquals(next, Current))
                return;
            Current = next;
            Generation++;
        }

        public CloudClient? Resolve(int stampedGeneration) =>
            stampedGeneration == Generation ? Current : null;
    }
}
