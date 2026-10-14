import { privacyPolicyUrl } from "@/config/distribution";

describe("privacyPolicyUrl", () => {
  const github = "https://github.com/someone/wtf.ai/blob/main/docs/PRIVACY.md";
  const site = "https://someone.github.io/wtf.ai/privacy.html";

  it("gives Ukrainian the policy beside the English one, on GitHub and on the website", () => {
    expect(privacyPolicyUrl("uk", github)).toBe("https://github.com/someone/wtf.ai/blob/main/docs/PRIVACY.uk.md");
    expect(privacyPolicyUrl("uk", site)).toBe("https://someone.github.io/wtf.ai/privacy.uk.html");
  });

  it("keeps English, other addresses and a missing one as they are", () => {
    expect(privacyPolicyUrl("en", github)).toBe(github);
    expect(privacyPolicyUrl("uk", "https://example.org/policy")).toBe("https://example.org/policy");
    expect(privacyPolicyUrl("uk", null)).toBeNull();
  });
});
