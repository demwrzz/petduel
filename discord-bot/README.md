# PetDuel Discord Bot

## Çalıştırma
1. Klasörü masaüstüne çıkar.
2. `BASLAT.bat`'a çift tıkla. İlk seferde paketleri kurar (1-2 dk), sonra bot açılır.
   Bot kapanırsa 5 saniye sonra kendini yeniden başlatır. Durdurmak için pencereyi kapat.
3. Eski botu (aynı token ile çalışan) **kapat**, ikisi aynı anda açık olmasın.

`.env` dosyasında `DISCORD_TOKEN` (bot token) ve `BOT_KEY` (petduel.win bağlantı anahtarı) var.
Bunları kimseyle paylaşma, GitHub'a yükleme.

## Discord ayarları (bir kere)
- Discord Developer Portal → uygulaman → **Bot** → **Privileged Gateway Intents**:
  **Server Members Intent** ve **Message Content Intent** açık olsun (giriş/çıkış ve silinen mesaj logları için).
- Sunucuda botun rolüne **Administrator** ver ve bot rolünü rank rollerinin **üstüne** taşı.

## Kanallar
- Bot **hiç kanal kurmaz**, var olan kanalları kullanır.
- Kanalları `config.json` → `channelIds` içindeki ID ile, ID yoksa isimle bulur (emoji ve süsler önemsiz: "🪙┃coinflips" = coinflips).
- Coinflip ve jackpot → coinflip kanalı, giveaway ve event'ler → giveaway kanalı, çekim istekleri → #withdrawals (yoksa #admin-chat).
- Sitedeki 12 rank için renkli roller + `Linked` rolü sadece eksikse oluşturulur.
- Ticket butonunu koymak için kanalda `/ticketpanel` yaz.

## Komutlar
Herkes: `/link` `/unlink` `/profile` `/rank` `/leaderboard` `/stats` `/games` `/website` `/coinflip` `/help`
Yetkili: `/withdrawals` `/clear` `/timeout` `/kick` `/ban`
Admin: `/site maintenance|say|bot|block` `/player info|mute|ban|give|clearpets` `/match cancel`
`/event wheel|scramble|cancel` `/announce` `/giveaway start|end|reroll` `/ticketpanel`

## Siteyle bağlantı
- Yeni coinflipler ve sonuçları → #coinflips, jackpot → #jackpots, giveaway ve event'ler → #giveaways
- Çekim istekleri → #withdrawals, **Mark sent / Refund** butonlarıyla
- Oyuncular sitede Profile → **Link Discord** ile kod alır, Discord'da `/link KOD` yazar → rank rolü otomatik verilir
  (her 10 dakikada bir güncellenir)

Ayarlar `config.json` içinde (kanal adları, renk, yetkili rol adları).
