module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { url } = req.body || {};
  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "Missing profile URL" });
  }

  // Validate URL format
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return res.status(400).json({ error: "Invalid URL format" });
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    return res.status(400).json({ error: "URL must be http or https" });
  }

  // Fetch the profile JSON
  let profileData;
  try {
    const fetchRes = await fetch(url);
    if (!fetchRes.ok) {
      return res.status(400).json({ error: `Could not fetch profile: HTTP ${fetchRes.status}` });
    }
    profileData = await fetchRes.json();
  } catch (err) {
    return res.status(400).json({ error: `Could not fetch profile: ${err.message}` });
  }

  // Normalize fields to match our schema
  const geo = profileData.geolocation || {};
  const tags = profileData.tags || profileData.keywords || [];
  const profile = {
    profile_url: url,
    name: profileData.name || profileData.title || "Unknown",
    description: profileData.description || profileData.mission || null,
    latitude: geo.lat != null ? Number(geo.lat) : (profileData.latitude != null ? Number(profileData.latitude) : null),
    longitude: geo.lon != null ? Number(geo.lon) : (profileData.longitude != null ? Number(profileData.longitude) : null),
    locality: profileData.locality || null,
    region: profileData.region || null,
    country: profileData.country_name || profileData.country || null,
    tags: Array.isArray(tags) ? tags : [],
    primary_url: profileData.primary_url || profileData.url || null,
    image: profileData.image || null,
    source: "user-submitted",
  };

  // On Vercel we can't write to the filesystem or run a local embedding model.
  // Return the profile so the client can embed it in-browser and store in localStorage.
  res.json({ ok: true, profile, clientSideEmbed: true });
};
