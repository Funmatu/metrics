//Imports
import { indepth as indepth_analyzer, recent as recent_analyzer } from "./analyzers.mjs"

//Setup
export default async function({login, data, imports, q, rest, account}, {enabled = false, extras = false} = {}) {
  //Plugin execution
  try {
    //Check if plugin is enabled and requirements are met
    if ((!q.languages) || (!imports.metadata.plugins.languages.enabled(enabled, {extras})))
      return null

    //Context
    let context = {mode: "user"}
    if (q.repo) {
      console.debug(`metrics/compute/${login}/plugins > languages > switched to repository mode`)
      const {owner, repo} = data.user.repositories.nodes.map(({name: repo, owner: {login: owner}}) => ({repo, owner})).shift()
      context = {...context, mode: "repository", owner, repo}
    }

    //Load inputs
    let {ignored, skipped, other, colors, aliases, details, threshold, limit, indepth, "indepth.custom": _indepth_custom, "analysis.timeout": _timeout_global, "analysis.timeout.repositories": _timeout_repositories, sections, categories, "recent.categories": _recent_categories, "recent.load": _recent_load, "recent.days": _recent_days} = imports.metadata
      .plugins.languages
      .inputs({
        data,
        account,
        q,
      })
    const timeout = {global: _timeout_global, repositories: _timeout_repositories}
    threshold = (Number(threshold.replace(/%$/, "")) || 0) / 100
    skipped.push(...data.shared["repositories.skipped"])
    if (!limit)
      limit = Infinity
    if (!indepth)
      details = details.filter(detail => !["lines"].includes(detail))
    aliases = Object.fromEntries(aliases.split(",").filter(alias => /^[\s\S]+:[\s\S]+$/.test(alias)).map(alias => alias.trim().split(":")).map(([key, value]) => [key.toLocaleLowerCase(), value]))

    //Custom colors
    const colorsets = JSON.parse(`${await imports.fs.readFile(`${imports.__module(import.meta.url)}/colorsets.json`)}`)
    if ((`${colors}` in colorsets) && (limit <= 8))
      colors = colorsets[`${colors}`]
    colors = Object.fromEntries(decodeURIComponent(colors).split(",").map(x => x.trim().toLocaleLowerCase()).filter(x => x).map(x => x.split(":").map(x => x.trim())))
    console.debug(`metrics/compute/${login}/plugins > languages > custom colors ${JSON.stringify(colors)}`)

    //Unique languages
    const repositories = context.mode === "repository" ? data.user.repositories.nodes : [...data.user.repositories.nodes, ...data.user.repositoriesContributedTo.nodes]
    const unique = new Set(repositories.flatMap(repository => repository.languages.edges.map(({node: {name}}) => name))).size

    //Iterate through user's repositories and retrieve languages data
    console.debug(`metrics/compute/${login}/plugins > languages > processing ${data.user.repositories.nodes.length} repositories`)
    const languages = {unique, sections, details, indepth, colors: {}, total: 0, stats: {}, "stats.recent": {}}
    const customColors = {}
    for (const repository of data.user.repositories.nodes) {
      //Skip repository if asked
      if (!imports.filters.repo(repository, skipped))
        continue
      //Process repository languages
      for (const {size, node: {color, name}} of Object.values(repository.languages.edges)) {
        languages.stats[name] = (languages.stats[name] ?? 0) + size
        if (colors[name.toLocaleLowerCase()])
          customColors[name] = colors[name.toLocaleLowerCase()]
        if (!languages.colors[name])
          languages.colors[name] = color
        languages.total += size
      }
    }

    //Recently used languages
    if ((sections.includes("recently-used")) && (imports.metadata.plugins.languages.extras("indepth", {extras}))) {
      try {
        console.debug(`metrics/compute/${login}/plugins > languages > using recent analyzer`)
        languages["stats.recent"] = await recent_analyzer({login, data, imports, rest, context, account}, {skipped, categories: _recent_categories ?? categories, days: _recent_days, load: _recent_load, timeout})
        Object.assign(languages.colors, languages["stats.recent"].colors)
      }
      catch (error) {
        console.debug(`metrics/compute/${login}/plugins > languages > recent analyzer > ${error}`)
      }
    }

    //Indepth mode
    if ((indepth) && (imports.metadata.plugins.languages.extras("indepth", {extras}))) {
      try {
        console.debug(`metrics/compute/${login}/plugins > languages > switching to indepth mode (this may take some time)`)
        const existingColors = languages.colors
        Object.assign(languages, await indepth_analyzer({login, data, imports, rest, context, repositories: repositories.concat(_indepth_custom)}, {skipped, categories, timeout}))
        Object.assign(languages.colors, existingColors)
        console.debug(`metrics/compute/${login}/plugins > languages > indepth analysis processed successfully ${languages.commits} and missed ${languages.missed.commits} commits in ${languages.elapsed.toFixed(2)}m`)
      }
      catch (error) {
        console.debug(`metrics/compute/${login}/plugins > languages > indepth analyzer > ${error}`)
      }
    }

    //Apply aliases and group languages when needed
    for (const stats of [languages.stats, languages.lines, languages["stats.recent"].stats, languages["stats.recent"].lines]) {
      if (!stats)
        continue
      for (const [language, value] of Object.entries(stats)) {
        if (language.toLocaleLowerCase() in aliases) {
          delete stats[language]
          const alias = aliases[language.toLocaleLowerCase()]
          stats[alias] = (stats[alias] ?? 0) + value
          console.debug(`metrics/compute/${login}/plugins > languages > ${language} -> ${alias}: ${stats[alias]} (+${value})`)
        }
      }
    }

    //Compute languages stats
    // 修正: ループ内のロジックを「行数基準」に書き換え
    for (const {section, stats = {}, lines = {}, missed = {bytes: 0, lines: 0}, total = 0} of [{section: "favorites", stats: languages.stats, lines: languages.lines, total: languages.total, missed: languages.missed}, {section: "recent", ...languages["stats.recent"]}]) {
      console.debug(`metrics/compute/${login}/plugins > languages > formatting stats ${section}`)
      
      // 1. 全行数を計算（パーセンテージの分母用）
      const totalLines = Object.values(lines).reduce((a, b) => a + b, 0) || 1

      languages[section] = Object.entries(stats)
        .filter(([name]) => imports.filters.text(name, ignored))
        .sort(([_an], [_bn]) => (lines[_bn] || 0) - (lines[_an] || 0)) // 2. 行数でソート
        .slice(0, limit)
        .map(([name, byteSize]) => ({
            name, 
            value: lines[name] || 0, // 3. グラフの値を「行数」に変更
            size: byteSize,          // バイト数は表示用にsizeとして保持
            color: languages.colors[name], 
            x: 0
        }))
        .filter(({value}) => value / totalLines > threshold) // 4. 足切りも行数ベースで判定

      // 5. "Other"（その他）カテゴリの計算も行数ベースに変更
      if (other) {
        // indepthモードなら解析できなかった行数、そうでなければリストに含まれない言語の行数を合計
        let value = indepth ? (missed.lines || 0) : Object.entries(lines).filter(([name]) => !Object.values(languages[section]).map(({name}) => name).includes(name)).reduce((a, [_, b]) => a + b, 0)
        
        // limit制限でリストから溢れた言語があれば、その行数をOtherに足す
        if (languages[section].length === limit) {
            const popped = languages[section].pop()
            value += popped.value
        }
        
        if (value) {
          //dprint-ignore-next-line
          languages[section].push({name:"Other", value, size: value, get lines() { return value }, set lines(_) { }, x:0}) 
        }
      }

      // 6. 表示用合計値（グラフの100%幅）を行数の合計で計算
      const visible = {total: Object.values(languages[section]).map(({value}) => value).reduce((a, b) => a + b, 0)}

      for (let i = 0; i < languages[section].length; i++) {
        const {name} = languages[section][i]
        // 7. 各言語の割合を行数ベースで計算
        languages[section][i].value /= (visible.total || 1)
        languages[section][i].x = (languages[section][i - 1]?.x ?? 0) + (languages[section][i - 1]?.value ?? 0)
        languages[section][i].lines = lines[name] ?? 0
        
        if ((colors[i]) && (!colors[name.toLocaleLowerCase()]))
          languages[section][i].color = colors[i]
        else
          languages[section][i].color = customColors[name] ?? languages.colors[name] ?? "#ededed"
      }
    }

    //Results
    return languages
  }
  //Handle errors
  catch (error) {
    throw imports.format.error(error)
  }
}
