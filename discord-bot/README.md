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

## Bot ilk açıldığında otomatik olarak
- PET DUEL ve STAFF kategorilerini ve şu kanalları oluşturur (varsa dokunmaz):
  announcements, rules, how-to-play, website, giveaways, coinflips, jackpots, open-ticket, chat,
  withdrawals, admin-chat, moderator-chat, ticket-logs, bot-logs
- Sitedeki 12 rank için renkli roller + `Linked` rolü oluşturur
- open-ticket'e ticket butonu, rules / how-to-play / website kanallarına bilgi mesajlarını koyar

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
