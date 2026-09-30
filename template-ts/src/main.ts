// Copyright (C) 2023-2026 Swissmakers GmbH
// Author: Michael André Reber
// License: AGPL-3.0-or-later
// https://github.com/getmatinee/matinee

// Plugin template bundled to the manifest's main.js entrypoint by npm run build

const config = matinee.getConfig()
matinee.log(`${matinee.manifest.name} v${matinee.manifest.version} loaded`)

matinee.registerMetadataProvider({
  id: 'my-provider',
  mediaTypes: ['movie'],
  search(query, year, mediaType) {
    const response = matinee.http.fetch(
      `https://api.example.com/search?q=${encodeURIComponent(query)}&type=${mediaType}${year ? `&year=${year}` : ''}`,
      { headers: { Authorization: `Bearer ${config.api_key ?? ''}` } },
    )
    if (response.status !== 200) return []
    return JSON.parse(response.body).results.map((r: any) => ({
      id: r.id,
      title: r.title,
      year: r.year,
      overview: r.summary,
      poster_url: r.poster,
    }))
  },
  details(id, mediaType) {
    const response = matinee.http.fetch(`https://api.example.com/title/${mediaType}/${id}`)
    const data = JSON.parse(response.body)
    return {
      id,
      title: data.title,
      overview: data.summary,
      release_date: data.released,
      poster_url: data.poster,
      backdrop_url: data.backdrop,
      genres: data.genres,
      rating: data.rating,
    }
  },
})

matinee.registerScanner({
  id: 'my-anime-scanner',
  parseEpisode(path) {
    const match = /-\s*(\d{1,3})\s*[[(]/.exec(path)
    if (!match) return null
    return { season: 1, episode: parseInt(match[1], 10) }
  },
})
